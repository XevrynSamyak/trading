import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Config } from "./config.js";
import { USDC_MINT } from "./config.js";
import type { JupiterClient, RawInstruction } from "./jupiter.js";
import { requiredOutAtoms, slippageForFloor, usdcAtomsToUsd } from "./profit.js";
import { MAX_ACCOUNTS_PER_LEG, type Opportunity } from "./scanner.js";
import { getBalances } from "./wallet.js";

export interface ExecResult {
  status: "filled" | "skipped" | "failed";
  netUsd: number;
  feeUsd: number;
  signature?: string;
  reason?: string;
}

/** Paper mode: assume the quote fills exactly. Optimistic — real fills are worse. */
export function paperExecute(opp: Opportunity): ExecResult {
  return { status: "filled", netUsd: opp.eval.netUsd, feeUsd: opp.eval.feeUsd };
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

/**
 * Live mode: both legs go into ONE transaction. Leg 2's on-chain minimum output
 * is set to (input + fees + min profit), so if prices moved the whole
 * transaction reverts and only the network fee is lost. Preflight simulation
 * catches most of those before anything is paid at all.
 */
export async function liveExecute(
  opp: Opportunity,
  deps: { conn: Connection; jup: JupiterClient; wallet: Keypair; cfg: Config },
): Promise<ExecResult> {
  const { conn, jup, wallet, cfg } = deps;
  const inAtoms = BigInt(opp.leg1.inAmount);

  // Re-quote leg 2 with a slippage floor that guarantees profit.
  const required = requiredOutAtoms(inAtoms, opp.eval.feeUsd, cfg.minProfitBps);
  const slip = slippageForFloor(BigInt(opp.leg2.outAmount), required);
  if (slip === null) return { status: "skipped", netUsd: 0, feeUsd: 0, reason: "below profit floor" };
  const leg2 = await jup.quote({
    inputMint: opp.mint,
    outputMint: USDC_MINT,
    amount: BigInt(opp.leg1.outAmount),
    slippageBps: slip,
    maxAccounts: MAX_ACCOUNTS_PER_LEG,
  });
  if (BigInt(leg2.otherAmountThreshold) < required) {
    return { status: "skipped", netUsd: 0, feeUsd: 0, reason: "price moved before execution" };
  }

  const owner = wallet.publicKey.toBase58();
  const [ix1, ix2] = await Promise.all([jup.swapInstructions(opp.leg1, owner), jup.swapInstructions(leg2, owner)]);

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

  const luts = await loadLookupTables(conn, [...ix1.addressLookupTableAddresses, ...ix2.addressLookupTableAddresses]);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(luts);
  const tx = new VersionedTransaction(message);
  tx.sign([wallet]);

  let serializedOk = true;
  try {
    tx.serialize();
  } catch {
    serializedOk = false;
  }
  if (!serializedOk) return { status: "skipped", netUsd: 0, feeUsd: 0, reason: "route too large for one transaction" };

  const before = await getBalances(conn, wallet.publicKey);
  let signature: string;
  try {
    // Preflight on: a reverting arb is rejected by simulation without paying a fee.
    signature = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 2 });
  } catch (err) {
    return { status: "skipped", netUsd: 0, feeUsd: 0, reason: `simulation rejected: ${String(err).slice(0, 160)}` };
  }

  const conf = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  const after = await getBalances(conn, wallet.publicKey);
  const solPrice = opp.eval.feeUsd / ((5_000 + cfg.priorityFeeLamports) / 1e9);
  const feeUsd = ((before.lamports - after.lamports) / 1e9) * solPrice;
  const netUsd = usdcAtomsToUsd(after.usdcAtoms - before.usdcAtoms) - feeUsd;

  if (conf.value.err) {
    return { status: "failed", netUsd, feeUsd, signature, reason: JSON.stringify(conf.value.err) };
  }
  return { status: "filled", netUsd, feeUsd, signature };
}
