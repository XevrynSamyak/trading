import type { Cycle } from "./cycle.js";
import { BASE_FEE_LAMPORTS, lamportsToUsd, usdcAtomsToUsd } from "./profit.js";

/**
 * Execution cost model. Jupiter's quoted output already includes DEX fees
 * and price impact for the quoted size. What the quote does NOT include, and
 * this model adds before every decision:
 *   - Solana base fee (one signature)
 *   - priority fee
 *   - Jito tip (only when sending through Jito): a share of the expected
 *     profit, clamped between a minimum and a maximum — never so high that
 *     it eats the profit
 *   - a safety buffer for things we can't see (quote drift, rounding)
 */
export interface CostSettings {
  priorityFeeLamports: number;
  sendVia: "jito" | "rpc";
  /** Share of the room left after other costs offered to Jito as tip (0..1). */
  tipShare: number;
  minTipLamports: number;
  maxTipLamports: number;
  safetyBufferBps: number;
  safetyBufferUsd: number;
}

export interface Costs {
  baseFeeLamports: number;
  priorityFeeLamports: number;
  tipLamports: number;
  /** Paid in SOL when the transaction lands: base + priority + tip. */
  networkUsd: number;
  tipUsd: number;
  bufferUsd: number;
  /** Everything the quote does not already include. */
  totalUsd: number;
}

export function estimateCosts(grossUsd: number, inUsd: number, solPriceUsd: number, s: CostSettings): Costs {
  const baseUsd = lamportsToUsd(BASE_FEE_LAMPORTS, solPriceUsd);
  const prioUsd = lamportsToUsd(s.priorityFeeLamports, solPriceUsd);
  const bufferUsd = (inUsd * s.safetyBufferBps) / 10_000 + s.safetyBufferUsd;
  let tipLamports = 0;
  if (s.sendVia === "jito") {
    const room = grossUsd - baseUsd - prioUsd - bufferUsd;
    const wantLamports = room > 0 && solPriceUsd > 0 ? Math.floor(((room * s.tipShare) / solPriceUsd) * 1e9) : 0;
    tipLamports = Math.min(s.maxTipLamports, Math.max(s.minTipLamports, wantLamports));
  }
  const tipUsd = lamportsToUsd(tipLamports, solPriceUsd);
  const networkUsd = baseUsd + prioUsd + tipUsd;
  return {
    baseFeeLamports: BASE_FEE_LAMPORTS,
    priorityFeeLamports: s.priorityFeeLamports,
    tipLamports,
    networkUsd,
    tipUsd,
    bufferUsd,
    totalUsd: networkUsd + bufferUsd,
  };
}

/** Quoted gross vs. what's left after every cost. "net" is an estimate, not profit. */
export interface Valuation {
  inUsd: number;
  outUsd: number;
  grossUsd: number;
  grossBps: number;
  costs: Costs;
  netUsd: number;
  netBps: number;
}

export function valueCycle(c: Pick<Cycle, "inAtoms" | "outAtoms">, solPriceUsd: number, s: CostSettings): Valuation {
  const inUsd = usdcAtomsToUsd(c.inAtoms);
  const outUsd = usdcAtomsToUsd(c.outAtoms);
  const grossUsd = outUsd - inUsd;
  const costs = estimateCosts(grossUsd, inUsd, solPriceUsd, s);
  const netUsd = grossUsd - costs.totalUsd;
  const bps = (x: number) => (inUsd > 0 ? (x / inUsd) * 10_000 : 0);
  return { inUsd, outUsd, grossUsd, grossBps: bps(grossUsd), costs, netUsd, netBps: bps(netUsd) };
}
