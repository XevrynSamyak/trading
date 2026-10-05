import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import type { Config } from "./config.js";
import type { Costs, CostSettings, Valuation } from "./costs.js";
import { quoteCycle, specOf, type Cycle } from "./cycle.js";
import type { JitoClient } from "./jito.js";
import type { JupiterClient, RawInstruction } from "./jupiter.js";
import { BASE_FEE_LAMPORTS, lamportsToUsd, requiredOutAtoms, slippageForFloor, usdcAtomsToUsd } from "./profit.js";
import { getBalances, tokenAmountFromData, usdcAta } from "./wallet.js";

/**
 * filled   – the trade happened (micro/live), would have succeeded on-chain
 *            (simulated), or the fresh re-quote still showed the gap (quote-only)
 * stale    – the gap was already gone when every leg was re-quoted moments
 *            later; nothing was built or sent
 * rejected – it would have reverted (simulation) or was dropped without
 *            landing; cost nothing
 * skipped  – the bot chose not to try (route too large, Jito unavailable, ...)
 * failed   – it landed on-chain and failed, paying the network fee
 * timeout  – landing could not be confirmed; trading is disabled until checked
 */
export type ExecStatus = "filled" | "rejected" | "skipped" | "failed" | "stale" | "timeout";

export interface ExecTimings {
  requoteStart?: number;
  requoteEnd?: number;
  built?: number;
  submitted?: number;
  landed?: number;
  confirmed?: number;
}

export interface ExecResult {
  status: ExecStatus;
  /** Net USD on this mode's basis: quoted (quote-only), simulated (paper) or realized (micro/live). */
  netUsd: number;
  feeUsd: number;
  signature?: string;
  reason?: string;
  /** True if checked against the real chain (on-chain simulation or a real transaction). */
  verified?: boolean;
  /** The fresh re-quote of every leg right before building (the "executable" stage). */
  executable?: Valuation;
  /** What the on-chain simulation said the trade would make (paper and real modes). */
  simulatedNetUsd?: number;
  /** Which leg made it fail: 1..N, or 0 for a non-swap instruction. */
  failedLeg?: number;
  tipLamports?: number;
  t: ExecTimings;
}

export interface ExecDeps {
  conn: Connection;
  jup: JupiterClient;
  cfg: Pick<Config, "computeUnitLimit" | "sendVia" | "maxSlippageBps" | "landingTimeoutMs" | "priorityFeeLamports">;
  costSettings: CostSettings;
  solPriceUsd: number;
  /** Jito tip account; required for real trades sent via Jito. */
  tipAccount?: PublicKey;
  /** Minimum net edge (bps) the on-chain floor must guarantee on top of network costs. */
  floorBps: number;
  now?: () => number;
}

const result = (status: ExecStatus, t: ExecTimings, extra: Partial<ExecResult> = {}): ExecResult => ({
  status,
  netUsd: 0,
  feeUsd: 0,
  t,
  ...extra,
});

/** Re-values a cycle with fixed costs (the tip and buffer decided for this attempt). */
export function revalue(c: Pick<Cycle, "inAtoms" | "outAtoms">, costs: Costs): Valuation {
  const inUsd = usdcAtomsToUsd(c.inAtoms);
  const outUsd = usdcAtomsToUsd(c.outAtoms);
  const grossUsd = outUsd - inUsd;
  const netUsd = grossUsd - costs.totalUsd;
  const bps = (x: number) => (inUsd > 0 ? (x / inUsd) * 10_000 : 0);
  return { inUsd, outUsd, grossUsd, grossBps: bps(grossUsd), costs, netUsd, netBps: bps(netUsd) };
}

export interface FloorPlan {
  /** Minimum USDC (atoms) the last leg must return on-chain: input + network costs + min profit. */
  required: bigint;
  /** Slippage on the last leg's quote that puts its on-chain minimum at (or above) `required`. */
  slippageBps: number;
}

export function planFloor(candidate: Pick<Cycle, "inAtoms" | "outAtoms">, costs: Costs, floorBps: number, maxSlippageBps: number): FloorPlan | null {
  const required = requiredOutAtoms(candidate.inAtoms, costs.networkUsd, floorBps);
  const slip = slippageForFloor(candidate.outAtoms, required);
  if (slip === null) return null;
  return { required, slippageBps: Math.min(slip, maxSlippageBps) };
}

/**
 * Executable stage: re-quotes EVERY leg back-to-back right before building
 * (the old version reused a seconds-old first leg). The last leg carries the
 * profit floor; if its fresh on-chain minimum is below what's required, the
 * gap is gone and nothing is built.
 */
export async function freshQuote(
  candidate: Cycle,
  costs: Costs,
  plan: FloorPlan,
  deps: ExecDeps,
  t: ExecTimings,
): Promise<{ cycle: Cycle; val: Valuation } | ExecResult> {
  const now = deps.now ?? Date.now;
  t.requoteStart = now();
  const cycle = await quoteCycle(deps.jup, specOf(candidate), candidate.inAtoms, {
    lastLegSlippageBps: plan.slippageBps,
    marketTs: candidate.marketTs,
    now,
  });
  t.requoteEnd = now();
  const val = revalue(cycle, costs);
  const last = cycle.legs[cycle.legs.length - 1];
  if (BigInt(last.otherAmountThreshold) < plan.required) {
    return result("stale", t, {
      executable: val,
      reason: `gap gone at fresh re-quote (executable ${val.netBps.toFixed(1)}bps)`,
    });
  }
  return { cycle, val };
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
  /** Instruction index range [first, last] of each leg, for blaming the failing leg. */
  legRanges: [number, number][];
}

/**
 * ONE transaction: compute budget, every leg's setup + swap (+ the last leg's
 * cleanup), then the Jito tip. All legs land together or not at all.
 */
export async function buildCycleTx(
  cycle: Cycle,
  owner: PublicKey,
  costs: Costs,
  deps: ExecDeps,
): Promise<BuiltTx | ExecResult> {
  const ownerStr = owner.toBase58();
  const sets = await Promise.all(cycle.legs.map((q) => deps.jup.swapInstructions(q, ownerStr)));

  const microLamportsPerCu = Math.floor((deps.costSettings.priorityFeeLamports * 1_000_000) / deps.cfg.computeUnitLimit);
  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: deps.cfg.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: microLamportsPerCu }),
  ];
  const legRanges: [number, number][] = [];
  sets.forEach((set, i) => {
    const start = instructions.length;
    instructions.push(...set.setupInstructions.map(toInstruction), toInstruction(set.swapInstruction));
    if (i === sets.length - 1 && set.cleanupInstruction) instructions.push(toInstruction(set.cleanupInstruction));
    legRanges.push([start, instructions.length - 1]);
  });
  if (deps.tipAccount && deps.costSettings.sendVia === "jito" && costs.tipLamports > 0) {
    instructions.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: deps.tipAccount, lamports: costs.tipLamports }));
  }

  const luts = await loadLookupTables(deps.conn, sets.flatMap((s) => s.addressLookupTableAddresses));
  const { blockhash, lastValidBlockHeight } = await deps.conn.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions }).compileToV0Message(
    luts,
  );
  const tx = new VersionedTransaction(message);
  try {
    tx.serialize();
  } catch {
    return result("skipped", {}, { reason: "route too large for one transaction" });
  }
  return { tx, blockhash, lastValidBlockHeight, legRanges };
}

/** Which leg an on-chain error came from: 1..N, 0 for a non-swap instruction, undefined if unknown. */
export function failedLegOf(err: unknown, ranges: [number, number][]): number | undefined {
  const ie = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
  if (!Array.isArray(ie)) return undefined;
  const idx = ie[0];
  const i = ranges.findIndex(([a, b]) => idx >= a && idx <= b);
  return i >= 0 ? i + 1 : 0;
}

const isResult = (x: unknown): x is ExecResult => typeof x === "object" && x !== null && "status" in x && "t" in x;
const shortErr = (e: unknown) => (typeof e === "string" ? e : JSON.stringify(e)).slice(0, 160);
const legNote = (leg: number | undefined, n: number) =>
  leg === undefined ? "" : leg === 0 ? " [non-swap instruction]" : ` [leg ${leg}/${n}${leg === 1 ? ": price moved before we landed" : ""}]`;

/** Shared start of every execution path: costs, floor, fresh re-quote of all legs. */
async function prepare(candidate: Cycle, val: Valuation, deps: ExecDeps, t: ExecTimings) {
  const plan = planFloor(candidate, val.costs, deps.floorBps, deps.cfg.maxSlippageBps);
  if (!plan) return result("skipped", t, { reason: "below profit floor" });
  const fresh = await freshQuote(candidate, val.costs, plan, deps, t);
  if (isResult(fresh)) return fresh;
  return { plan, ...fresh };
}

/**
 * Paper mode without a wallet: re-quotes every leg fresh (so we learn whether
 * gaps survive even a second); nothing is built or sent. Amounts are QUOTED.
 */
export async function quoteOnlyExecute(candidate: Cycle, val: Valuation, deps: ExecDeps): Promise<ExecResult> {
  const t: ExecTimings = {};
  const prep = await prepare(candidate, val, deps, t);
  if (isResult(prep)) return prep;
  return result("filled", t, {
    netUsd: prep.val.netUsd,
    feeUsd: prep.val.costs.networkUsd,
    executable: prep.val,
    tipLamports: prep.val.costs.tipLamports,
    verified: false,
    reason: "quote-only: not checked on-chain",
  });
}

/**
 * Paper mode with a public address: builds the exact transaction real mode
 * would send and simulates it against the real chain. Nothing is signed or
 * sent. Amounts are SIMULATED.
 */
export async function simulateExecute(candidate: Cycle, val: Valuation, owner: PublicKey, deps: ExecDeps): Promise<ExecResult> {
  const t: ExecTimings = {};
  const prep = await prepare(candidate, val, deps, t);
  if (isResult(prep)) return prep;
  const built = await buildCycleTx(prep.cycle, owner, prep.val.costs, deps);
  if (isResult(built)) return { ...built, t, executable: prep.val };
  t.built = (deps.now ?? Date.now)();

  const ata = usdcAta(owner);
  let pre: bigint;
  try {
    pre = BigInt((await deps.conn.getTokenAccountBalance(ata, "processed")).value.amount);
  } catch {
    return result("skipped", t, { executable: prep.val, reason: "wallet has no USDC account to simulate with" });
  }
  const sim = await deps.conn.simulateTransaction(built.tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "processed",
    accounts: { encoding: "base64", addresses: [ata.toBase58()] },
  });
  if (sim.value.err) {
    const leg = failedLegOf(sim.value.err, built.legRanges);
    return result("rejected", t, {
      executable: prep.val,
      failedLeg: leg,
      verified: true,
      reason: `would revert: ${shortErr(sim.value.err)}${legNote(leg, prep.cycle.legs.length)}`,
    });
  }
  const acct = sim.value.accounts?.[0];
  if (!acct) return result("skipped", t, { executable: prep.val, reason: "simulation returned no balance" });
  const post = tokenAmountFromData(Buffer.from(acct.data[0], "base64"));
  const netUsd = usdcAtomsToUsd(post - pre) - prep.val.costs.networkUsd;
  return result("filled", t, {
    netUsd,
    feeUsd: prep.val.costs.networkUsd,
    executable: prep.val,
    simulatedNetUsd: netUsd,
    tipLamports: prep.val.costs.tipLamports,
    verified: true,
    reason: "simulated on-chain",
  });
}

/** Waits until the transaction lands, its blockhash expires (it can then never land), or the timeout. */
async function waitForLanding(
  conn: Connection,
  signature: string,
  lastValidBlockHeight: number,
  timeoutMs: number,
  now: () => number,
): Promise<{ landed: boolean; err?: unknown; timedOut?: boolean }> {
  const start = now();
  for (;;) {
    try {
      const { value } = await conn.getSignatureStatuses([signature]);
      const st = value[0];
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        return { landed: true, err: st.err ?? undefined };
      }
      if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) return { landed: false };
    } catch {
      // An RPC hiccup must not lose track of a sent transaction: keep asking until the timeout.
    }
    if (now() - start > timeoutMs) return { landed: false, timedOut: true };
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/**
 * After a send error, could the transaction still have reached the network?
 * A service that answered with an error refused it; no answer at all (timeout,
 * connection reset) means it may have arrived and can still land.
 */
export function sendMayHaveReached(err: unknown): boolean {
  if (err instanceof SendTransactionError) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return !/^Jito \w+( \d{3})?:/.test(msg);
}

/** Retries a read a few times (RPC hiccups), so a landed trade's result isn't lost. */
async function readWithRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 1_000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/**
 * MICRO/LIVE: fresh re-quote, build, sign, simulate (free), send, wait.
 * Through Jito the transaction goes as a single-transaction bundle, which Jito
 * documents as revert-protected. Amounts are REALIZED (wallet balance change
 * minus the fee the transaction actually paid).
 */
export async function liveExecute(
  candidate: Cycle,
  val: Valuation,
  wallet: Keypair,
  deps: ExecDeps & { jito?: JitoClient },
): Promise<ExecResult> {
  const now = deps.now ?? Date.now;
  const t: ExecTimings = {};
  const { conn, cfg } = deps;
  if (cfg.sendVia === "jito" && (!deps.jito || !deps.tipAccount)) return result("skipped", t, { reason: "Jito not available" });

  const prep = await prepare(candidate, val, deps, t);
  if (isResult(prep)) return prep;
  const built = await buildCycleTx(prep.cycle, wallet.publicKey, prep.val.costs, deps);
  if (isResult(built)) return { ...built, t, executable: prep.val };
  built.tx.sign([wallet]);
  t.built = now();
  const n = prep.cycle.legs.length;

  const sim = await conn.simulateTransaction(built.tx, { commitment: "processed" });
  if (sim.value.err) {
    const leg = failedLegOf(sim.value.err, built.legRanges);
    return result("rejected", t, {
      executable: prep.val,
      failedLeg: leg,
      verified: true,
      reason: `would revert: ${shortErr(sim.value.err)}${legNote(leg, n)}`,
    });
  }

  const before = await getBalances(conn, wallet.publicKey);
  // The signature is known before sending, so landing can be checked even if the send call fails.
  let signature = bs58.encode(built.tx.signatures[0]);
  let sendError: string | undefined;
  try {
    signature =
      cfg.sendVia === "jito"
        ? await deps.jito!.sendTransaction(Buffer.from(built.tx.serialize()).toString("base64"))
        : await conn.sendTransaction(built.tx, { skipPreflight: true, maxRetries: 2 });
  } catch (err) {
    sendError = String(err instanceof Error ? err.message : err).slice(0, 160);
    if (!sendMayHaveReached(err)) {
      return result("rejected", t, { executable: prep.val, reason: `send refused: ${sendError}` });
    }
    // No answer: it may still land. Watch for it like any sent transaction.
  }
  t.submitted = now();

  const landing = await waitForLanding(conn, signature, built.lastValidBlockHeight, cfg.landingTimeoutMs, now);
  if (landing.timedOut) {
    return result("timeout", t, {
      signature,
      executable: prep.val,
      reason: `could not confirm within ${Math.round(cfg.landingTimeoutMs / 1000)}s; check https://solscan.io/tx/${signature}`,
    });
  }
  if (!landing.landed) {
    const why = sendError ? `send got no answer (${sendError}) and it never landed (no fee paid)` : "did not land (no fee paid)";
    return result("rejected", t, { signature, executable: prep.val, verified: true, reason: why });
  }
  t.landed = now();

  let after: Awaited<ReturnType<typeof getBalances>>;
  let info: Awaited<ReturnType<Connection["getTransaction"]>>;
  try {
    after = await readWithRetry(() => getBalances(conn, wallet.publicKey));
    // Fee from the transaction itself (+ tip). A balance diff would wrongly count
    // the refundable deposit for a newly opened token account as a loss.
    info = await readWithRetry(() => conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
  } catch (err) {
    // It landed but its result can't be read: treat as unknown, so trading stops until a person checks.
    return result("timeout", t, {
      signature,
      executable: prep.val,
      reason: `landed, but its result could not be read (${String(err).slice(0, 80)}); check https://solscan.io/tx/${signature}`,
    });
  }
  t.confirmed = now();
  const networkLamports =
    (info?.meta?.fee ?? BASE_FEE_LAMPORTS + deps.costSettings.priorityFeeLamports) +
    (cfg.sendVia === "jito" ? prep.val.costs.tipLamports : 0);
  const feeUsd = lamportsToUsd(networkLamports, deps.solPriceUsd);
  const netUsd = usdcAtomsToUsd(after.usdcAtoms - before.usdcAtoms) - feeUsd;
  if (landing.err) {
    const leg = failedLegOf(landing.err, built.legRanges);
    return result("failed", t, {
      netUsd,
      feeUsd,
      signature,
      executable: prep.val,
      failedLeg: leg,
      verified: true,
      tipLamports: prep.val.costs.tipLamports,
      reason: `${shortErr(landing.err)}${legNote(leg, n)}`,
    });
  }
  return result("filled", t, {
    netUsd,
    feeUsd,
    signature,
    executable: prep.val,
    tipLamports: prep.val.costs.tipLamports,
    verified: true,
  });
}

