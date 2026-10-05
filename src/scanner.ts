import { SOL_MINT, USDC_MINT } from "./config.js";
import { valueCycle, type CostSettings, type Valuation } from "./costs.js";
import { quoteCycle, type Cycle, type CycleSpec } from "./cycle.js";
import type { JupiterClient } from "./jupiter.js";

/** A quoted cycle and what it's worth after every cost (an estimate, not profit). */
export interface Scored {
  cycle: Cycle;
  val: Valuation;
}

export interface ScanOptions {
  onError?: (spec: CycleSpec, err: unknown) => void;
  /** If given, cycles are quoted one after another, awaiting this before each (rate-limit pacing). */
  beforeEach?: (spec: CycleSpec) => Promise<void>;
  marketTsFor?: (spec: CycleSpec) => number | undefined;
  /**
   * One-after-another scans only: return true to skip the remaining cycles,
   * so a gap is acted on while its quote is fresh instead of seconds later.
   */
  stopAfter?: (s: Scored) => boolean;
}

/**
 * Quotes each cycle (at its own size) and values it after costs. Results come
 * back best-first by net USD. Failed quotes are reported and skipped.
 */
export async function scanCycles(
  jup: JupiterClient,
  specs: CycleSpec[],
  sizeFor: (spec: CycleSpec) => bigint,
  solPriceUsd: number,
  costs: CostSettings,
  opts: ScanOptions = {},
): Promise<Scored[]> {
  const onError = opts.onError ?? (() => {});
  const one = async (spec: CycleSpec): Promise<Scored> => {
    const cycle = await quoteCycle(jup, spec, sizeFor(spec), { marketTs: opts.marketTsFor?.(spec) });
    return { cycle, val: valueCycle(cycle, solPriceUsd, costs) };
  };
  const results: Scored[] = [];
  if (opts.beforeEach) {
    // One cycle at a time: its legs stay back-to-back, and requests are spread out.
    for (const spec of specs) {
      try {
        await opts.beforeEach(spec);
        const scored = await one(spec);
        results.push(scored);
        if (opts.stopAfter?.(scored)) break;
      } catch (err) {
        onError(spec, err);
      }
    }
  } else {
    const settled = await Promise.allSettled(specs.map(one));
    settled.forEach((r, i) => (r.status === "fulfilled" ? results.push(r.value) : onError(specs[i], r.reason)));
  }
  return results.sort((a, b) => b.val.netUsd - a.val.netUsd);
}

export async function fetchSolPriceUsd(jup: JupiterClient): Promise<number> {
  const q = await jup.quote({ inputMint: SOL_MINT, outputMint: USDC_MINT, amount: 1_000_000_000n, slippageBps: 50 });
  return Number(q.outAmount) / 1e6;
}
