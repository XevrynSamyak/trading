import { USDC_MINT } from "./config.js";
import type { JupiterClient, QuoteResponse } from "./jupiter.js";

/**
 * An arbitrage cycle: start in USDC, trade through one or more tokens, end in
 * USDC — all legs in ONE atomic transaction.
 *   two-leg:  USDC → X → USDC
 *   triangle: USDC → A → B → USDC
 * Jupiter picks the best venue mix (Raydium, Orca, Meteora, ...) for each leg,
 * so cross-venue gaps show up as legs routed through different venues.
 */
export type CycleKind = "two-leg" | "triangle";

export interface CycleSpec {
  kind: CycleKind;
  /** Display/learning key: "JUP" or "SOL>JUP". */
  symbol: string;
  /** Token symbols passed through (for safety checks). */
  tokens: string[];
  /** Mints including start and end: [USDC, X, USDC] or [USDC, A, B, USDC]. */
  path: string[];
}

export interface Cycle extends CycleSpec {
  inAtoms: bigint;
  legs: QuoteResponse[];
  outAtoms: bigint;
  quoteStartedAt: number;
  quotedAt: number;
  /** Venue labels per leg, e.g. "Raydium>Orca | Meteora". */
  routes: string;
  /** Price impact Jupiter reports, summed over legs (bps; treats priceImpactPct as a fraction). */
  priceImpactBps: number;
  /** DEX fees charged along the route (bps of the traded amount). Already inside the quoted output. */
  dexFeeBps: number;
  /** Pool accounts the route uses (watched for changes by the event trigger). */
  pools: string[];
  /** When the market change that prompted this quote happened, if known. */
  marketTs?: number;
}

/** Account budget for all legs in one v0 transaction (lookup tables make room). */
export const TX_ACCOUNT_BUDGET = 56;
export const maxAccountsPerLeg = (legs: number) => Math.floor(TX_ACCOUNT_BUDGET / legs);

export function twoLegSpec(symbol: string, mint: string): CycleSpec {
  return { kind: "two-leg", symbol, tokens: [symbol], path: [USDC_MINT, mint, USDC_MINT] };
}

export function triangleSpec(a: [string, string], b: [string, string]): CycleSpec {
  return { kind: "triangle", symbol: `${a[0]}>${b[0]}`, tokens: [a[0], b[0]], path: [USDC_MINT, a[1], b[1], USDC_MINT] };
}

export const specOf = (c: Cycle): CycleSpec => ({ kind: c.kind, symbol: c.symbol, tokens: c.tokens, path: c.path });

const routeLabel = (q: QuoteResponse) => q.routePlan.map((r) => r.swapInfo.label ?? "?").join(">");

/** DEX fee of one leg in bps, from the fee each hop reports (weighted by split percent). */
export function legFeeBps(q: QuoteResponse): number {
  let bps = 0;
  for (const step of q.routePlan) {
    const s = step.swapInfo;
    const fee = Number(s.feeAmount ?? 0);
    if (!fee) continue;
    const base = s.feeMint === s.inputMint ? Number(s.inAmount ?? 0) : Number(s.outAmount ?? 0) + fee;
    if (base > 0) bps += (fee / base) * 10_000 * ((step.percent ?? 100) / 100);
  }
  return bps;
}

/**
 * Quotes every leg back-to-back: each leg sells exactly what the previous
 * one bought. Legs quote with 0 slippage except, optionally, the last one,
 * whose slippage sets the on-chain minimum output (the profit floor).
 */
export async function quoteCycle(
  jup: JupiterClient,
  spec: CycleSpec,
  inAtoms: bigint,
  opts: { lastLegSlippageBps?: number; marketTs?: number; now?: () => number } = {},
): Promise<Cycle> {
  const now = opts.now ?? Date.now;
  const quoteStartedAt = now();
  const legs: QuoteResponse[] = [];
  let amount = inAtoms;
  const nLegs = spec.path.length - 1;
  for (let i = 0; i < nLegs; i++) {
    const last = i === nLegs - 1;
    const q = await jup.quote({
      inputMint: spec.path[i],
      outputMint: spec.path[i + 1],
      amount,
      slippageBps: last ? (opts.lastLegSlippageBps ?? 0) : 0,
      maxAccounts: maxAccountsPerLeg(nLegs),
    });
    legs.push(q);
    amount = BigInt(q.outAmount);
  }
  const pools = [...new Set(legs.flatMap((q) => q.routePlan.map((r) => r.swapInfo.ammKey).filter((k): k is string => !!k)))];
  return {
    ...spec,
    inAtoms,
    legs,
    outAtoms: amount,
    quoteStartedAt,
    quotedAt: now(),
    routes: legs.map(routeLabel).join(" | "),
    priceImpactBps: legs.reduce((s, q) => s + Math.abs(Number(q.priceImpactPct) || 0) * 10_000, 0),
    dexFeeBps: legs.reduce((s, q) => s + legFeeBps(q), 0),
    pools,
    marketTs: opts.marketTs,
  };
}
