import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Config } from "./config.js";
import { USDC_MINT, extraFeeLamports } from "./config.js";
import type { JitoClient } from "./jito.js";
import type { JupiterClient, RawInstruction } from "./jupiter.js";
import { BASE_FEE_LAMPORTS, lamportsToUsd, requiredOutAtoms, slippageForFloor, usdcAtomsToUsd } from "./profit.js";
import { MAX_ACCOUNTS_PER_LEG, type Opportunity } from "./scanner.js";
import { getBalances, tokenAmountFromData, usdcAta } from "./wallet.js";

/**
 * filled   – the trade happened (or, when simulating, would have succeeded)
 * rejected – it would have reverted; caught before landing, so it cost nothing
 *            (the quoted gap was not real by the time we checked)
 * skipped  – the bot chose not to try (e.g. profit floor unreachable)
 * failed   – it landed on-chain and failed, paying the network fee
 */
export type ExecStatus = "filled" | "rejected" | "skipped" | "failed";

export interface ExecResult {
  status: ExecStatus;
  netUsd: number;
  feeUsd: number;
  signature?: string;
  reason?: string;
  /** True when the result was checked against the real chain, not just quotes. */
  verified?: boolean;
}

export interface ExecDeps {
  conn: Connection;
  jup: JupiterClient;
  cfg: Config;
  solPriceUsd: number;
  /** Jito tip account to pay; required for live trades sent via Jito. */
  tipAccount?: PublicKey;
}

const skipped = (reason: string): ExecResult => ({ status: "skipped", netUsd: 0, feeUsd: 0, reason });

/** Quote-only paper trading: assumes the quote fills exactly. Optimistic. */
export function paperExecute(opp: Opportunity): ExecResult {
  return { status: "filled", netUsd: opp.eval.netUsd, feeUsd: opp.eval.feeUsd, verified: false };
}

function toInstruction(ix: RawInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  });
}

async function loadLookupTables(conn: Connection, addresses: string[]): Promise<AddressLookupTableAccount[]> {
  const unique = [...new Set(addresses)];
  const tables = await Promise.all(unique.map((a) => conn.getAddressLookupTable(new PublicKey(a))));
  return tables.map((t) => t.value).filter((t): t is AddressLookupTableAccount => t !== null);
}

export interface BuiltTx {
  tx: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
}

/**
 * Builds the arbitrage as ONE transaction: both legs, plus the Jito tip when
 * one is given. Leg 2's on-chain minimum output is (input + fees + min
 * profit), so if prices moved the whole transaction reverts instead of losing.
 */
export async function buildArbTx(opp: Opportunity, owner: PublicKey, deps: ExecDeps): Promise<BuiltTx | ExecResult> {
  const { conn, jup, cfg } = deps;
  const inAtoms = BigInt(opp.leg1.inAmount);

  const required = requiredOutAtoms(inAtoms, opp.eval.feeUsd, cfg.minProfitBps);
  const slip = slippageForFloor(BigInt(opp.leg2.outAmount), required);
  if (slip === null) return skipped("below profit floor");
  const leg2 = await jup.quote({
    inputMint: opp.mint,
    outputMint: USDC_MINT,
    amount: BigInt(opp.leg1.outAmount),
    slippageBps: slip,
    maxAccounts: MAX_ACCOUNTS_PER_LEG,
  });
  if (BigInt(leg2.otherAmountThreshold) < required) return skipped("price moved before execution");

  const ownerStr = owner.toBase58();
  const [ix1, ix2] = await Promise.all([jup.swapInstructions(opp.leg1, ownerStr), jup.swapInstructions(leg2, ownerStr)]);

  const microLamportsPerCu = Math.floor((cfg.priorityFeeLamports * 1_000_000) / cfg.computeUnitLimit);
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cfg.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: microLamportsPerCu }),
    ...ix1.setupInstructions.map(toInstruction),
    toInstruction(ix1.swapInstruction),
    ...ix2.setupInstructions.map(toInstruction),
    toInstruction(ix2.swapInstruction),
    ...(ix2.cleanupInstruction ? [toInstruction(ix2.cleanupInstruction)] : []),
  ];
  if (deps.tipAccount && cfg.sendVia === "jito") {
    instructions.push(
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: deps.tipAccount, lamports: cfg.jitoTipLamports }),
    );
  }

  const luts = await loadLookupTables(conn, [...ix1.addressLookupTableAddresses, ...ix2.addressLookupTableAddresses]);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions }).compileToV0Message(
    luts,
  );
  const tx = new VersionedTransaction(message);
  try {
    tx.serialize();
  } catch {
    return skipped("route too large for one transaction");
  }
  return { tx, blockhash, lastValidBlockHeight };
}

const isResult = (x: BuiltTx | ExecResult): x is ExecResult => "status" in x;
const shortErr = (e: unknown) => (typeof e === "string" ? e : JSON.stringify(e)).slice(0, 160);

/**
 * Realistic paper trading: builds the exact transaction live mode would send
 * and simulates it against the real chain right now, using only the wallet's
 * public address. Nothing is signed or sent. Shows whether a quoted gap was
 * real, and what the trade would actually have made.
 */
export async function simulateExecute(opp: Opportunity, owner: PublicKey, deps: ExecDeps): Promise<ExecResult> {
  const built = await buildArbTx(opp, owner, deps);
  if (isResult(built)) return built;

  const ata = usdcAta(owner);
  let pre: bigint;
  try {
    pre = BigInt((await deps.conn.getTokenAccountBalance(ata, "processed")).value.amount);
  } catch {
    return skipped("wallet has no USDC account to simulate with");
  }

  const sim = await deps.conn.simulateTransaction(built.tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "processed",
    accounts: { encoding: "base64", addresses: [ata.toBase58()] },
  });
  if (sim.value.err) {
    return { status: "rejected", netUsd: 0, feeUsd: 0, reason: `would revert: ${shortErr(sim.value.err)}`, verified: true };
  }
  const acct = sim.value.accounts?.[0];
  if (!acct) return skipped("simulation returned no balance");
  const post = tokenAmountFromData(Buffer.from(acct.data[0], "base64"));
  const feeUsd = lamportsToUsd(BASE_FEE_LAMPORTS + extraFeeLamports(deps.cfg), deps.solPriceUsd);
  return {
    status: "filled",
    netUsd: usdcAtomsToUsd(post - pre) - feeUsd,
    feeUsd,
    reason: "simulated on-chain",
    verified: true,
  };
}

/** Waits until the transaction lands or its blockhash expires (then it can never land). */
async function waitForLanding(
  conn: Connection,
  signature: string,
  lastValidBlockHeight: number,
): Promise<{ landed: boolean; err?: unknown }> {
  for (;;) {
    const { value } = await conn.getSignatureStatuses([signature]);
    const st = value[0];
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      return { landed: true, err: st.err ?? undefined };
    }
    if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) return { landed: false };
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/**
 * Live trading. Simulates first (free), then sends. Through Jito the
 * transaction is revert-protected: if the gap is gone it is dropped and costs
 * nothing; the tip is paid only when it lands, and it only lands at a profit.
 */
export async function liveExecute(
  opp: Opportunity,
  wallet: Keypair,
  deps: ExecDeps & { jito?: JitoClient },
): Promise<ExecResult> {
  const { conn, cfg } = deps;
  if (cfg.sendVia === "jito" && (!deps.jito || !deps.tipAccount)) return skipped("Jito not available");

  const built = await buildArbTx(opp, wallet.publicKey, deps);
  if (isResult(built)) return built;
  built.tx.sign([wallet]);

  const sim = await conn.simulateTransaction(built.tx, { commitment: "processed" });
  if (sim.value.err) return { status: "rejected", netUsd: 0, feeUsd: 0, reason: `would revert: ${shortErr(sim.value.err)}` };

  const before = await getBalances(conn, wallet.publicKey);
  let signature: string;
  try {
    signature =
      cfg.sendVia === "jito"
        ? await deps.jito!.sendTransaction(Buffer.from(built.tx.serialize()).toString("base64"))
        : await conn.sendTransaction(built.tx, { skipPreflight: true, maxRetries: 2 });
  } catch (err) {
    return { status: "rejected", netUsd: 0, feeUsd: 0, reason: `send refused: ${String(err).slice(0, 160)}` };
  }

  const landing = await waitForLanding(conn, signature, built.lastValidBlockHeight);
  if (!landing.landed) {
    return { status: "rejected", netUsd: 0, feeUsd: 0, signature, reason: "did not land (no fee paid)" };
  }

  const after = await getBalances(conn, wallet.publicKey);
  // Fee from the transaction itself (+ tip). A balance diff would wrongly count
  // the refundable deposit for a newly opened token account as a loss.
  const info = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const networkLamports =
    (info?.meta?.fee ?? BASE_FEE_LAMPORTS + cfg.priorityFeeLamports) + (cfg.sendVia === "jito" ? cfg.jitoTipLamports : 0);
  const feeUsd = lamportsToUsd(networkLamports, deps.solPriceUsd);
  const netUsd = usdcAtomsToUsd(after.usdcAtoms - before.usdcAtoms) - feeUsd;
  if (landing.err) return { status: "failed", netUsd, feeUsd, signature, reason: shortErr(landing.err), verified: true };
  return { status: "filled", netUsd, feeUsd, signature, verified: true };
}
