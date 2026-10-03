import { USDC_DECIMALS } from "./config.js";

const USDC_UNIT = 10 ** USDC_DECIMALS;
export const BASE_FEE_LAMPORTS = 5_000;

export const usdToUsdcAtoms = (usd: number): bigint => BigInt(Math.round(usd * USDC_UNIT));
export const usdcAtomsToUsd = (atoms: bigint): number => Number(atoms) / USDC_UNIT;
export const lamportsToUsd = (lamports: number, solPriceUsd: number): number => (lamports / 1e9) * solPriceUsd;

export interface Evaluation {
  inUsd: number;
  outUsd: number;
  grossUsd: number;
  feeUsd: number;
  netUsd: number;
  netBps: number;
}

/** Profit of a USDC -> X -> USDC round trip after network fees. */
export function evaluateRoundTrip(
  inAtoms: bigint,
  outAtoms: bigint,
  priorityFeeLamports: number,
  solPriceUsd: number,
): Evaluation {
  const inUsd = usdcAtomsToUsd(inAtoms);
  const outUsd = usdcAtomsToUsd(outAtoms);
  const grossUsd = outUsd - inUsd;
  const feeUsd = lamportsToUsd(BASE_FEE_LAMPORTS + priorityFeeLamports, solPriceUsd);
  const netUsd = grossUsd - feeUsd;
  return { inUsd, outUsd, grossUsd, feeUsd, netUsd, netBps: inUsd > 0 ? (netUsd / inUsd) * 10_000 : 0 };
}

/**
 * Smallest USDC amount leg 2 must return for the trade to clear fees plus the
 * minimum profit. Enforced on-chain as leg 2's slippage floor, so a trade that
 * would lose money reverts instead of filling.
 */
export function requiredOutAtoms(inAtoms: bigint, feeUsd: number, minProfitBps: number): bigint {
  const inUsd = usdcAtomsToUsd(inAtoms);
  const needUsd = inUsd + feeUsd + (inUsd * minProfitBps) / 10_000;
  return BigInt(Math.ceil(needUsd * USDC_UNIT));
}

/** Slippage (bps) that makes leg 2's on-chain minimum equal `required`; null if not achievable. */
export function slippageForFloor(quotedOut: bigint, required: bigint): number | null {
  if (quotedOut < required) return null;
  return Number(((quotedOut - required) * 10_000n) / quotedOut);
}
