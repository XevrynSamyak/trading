import type { Valuation } from "./costs.js";
import type { Cycle } from "./cycle.js";

/**
 * Trade-size optimiser. Bigger trades earn more per gap but move the price
 * more, so profit vs. size usually rises, peaks, then falls:
 *
 *   $100 → +$1.40   $500 → +$7.20   $1,000 → +$12.30
 *   $1,500 → +$15.20   $2,000 → +$15.80   $3,000 → +$12.40   → choose $2,000
 *
 * Each extra size costs a quote of every leg, so the ladder only runs on
 * candidates, with a capped number of points spread evenly in log space.
 */
export interface SizeLimits {
  /** Largest allowed: wallet × exposure cap, MAX_TRADE_USD, MICRO cap — whichever is smallest. */
  maxUsd: number;
  minUsd: number;
}

/** Sizes to evaluate: ladder points within limits plus the largest allowed, thinned to `maxPoints`. */
export function ladderSizes(ladder: number[], limits: SizeLimits, maxPoints: number, already?: number): number[] {
  const top = Math.floor(limits.maxUsd * 100) / 100;
  if (top < limits.minUsd) return [];
  const all = [...new Set([...ladder.filter((x) => x >= limits.minUsd && x < top), top, ...(already ? [already] : [])])]
    .filter((x) => x >= limits.minUsd && x <= top)
    .sort((a, b) => a - b);
  if (all.length <= maxPoints) return all;
  if (maxPoints === 1) return [already !== undefined && all.includes(already) ? already : top];
  // Priority: the largest allowed size, the size already quoted (free), the smallest;
  // then fill with the points nearest to targets evenly spaced in log space.
  const keep = new Set<number>();
  for (const x of [all[all.length - 1], ...(already !== undefined && all.includes(already) ? [already] : []), all[0]]) {
    if (keep.size < maxPoints) keep.add(x);
  }
  const lo = Math.log(all[0]);
  const hi = Math.log(all[all.length - 1]);
  const dist = (x: number, target: number) => Math.abs(Math.log(x) - Math.log(target));
  for (let i = 1; i < maxPoints - 1 && keep.size < maxPoints; i++) {
    const target = Math.exp(lo + ((hi - lo) * i) / (maxPoints - 1));
    const remaining = all.filter((x) => !keep.has(x));
    keep.add(remaining.reduce((best, x) => (dist(x, target) < dist(best, target) ? x : best)));
  }
  // Targets can collide; fill any gap with the point farthest (in log terms) from those kept.
  while (keep.size < maxPoints) {
    const remaining = all.filter((x) => !keep.has(x));
    const gap = (x: number) => Math.min(...[...keep].map((k) => Math.abs(Math.log(x) - Math.log(k))));
    keep.add(remaining.reduce((best, x) => (gap(x) > gap(best) ? x : best)));
  }
  return [...keep].sort((a, b) => a - b);
}

export interface SizePoint {
  sizeUsd: number;
  cycle: Cycle;
  val: Valuation;
  evUsd: number;
  impactBps: number;
  feasible: boolean;
  reason?: string;
}

/** The size with the highest expected value among feasible points (positive EV, impact within the limit). */
export function pickBestSize(points: SizePoint[]): SizePoint | undefined {
  return points.filter((p) => p.feasible).sort((a, b) => b.evUsd - a.evUsd)[0];
}

export function makePoint(cycle: Cycle, val: Valuation, evUsd: number, maxImpactBps: number): SizePoint {
  const reason =
    cycle.priceImpactBps > maxImpactBps
      ? `price impact ${cycle.priceImpactBps.toFixed(0)}bps > ${maxImpactBps}`
      : evUsd <= 0
        ? "no positive expected value"
        : undefined;
  return { sizeUsd: val.inUsd, cycle, val, evUsd, impactBps: cycle.priceImpactBps, feasible: !reason, reason };
}

/**
 * Evaluates every size in `sizes` (reusing an existing quote when its size
 * matches) and returns all points, smallest first. Quote failures are skipped.
 */
export async function evaluateLadder(
  sizes: number[],
  quoteAt: (sizeUsd: number) => Promise<{ cycle: Cycle; val: Valuation }>,
  evOf: (cycle: Cycle, val: Valuation) => number,
  maxImpactBps: number,
  existing?: { cycle: Cycle; val: Valuation },
  onError: (sizeUsd: number, err: unknown) => void = () => {},
): Promise<SizePoint[]> {
  const points: SizePoint[] = [];
  for (const size of sizes) {
    try {
      const q =
        existing && Math.abs(existing.val.inUsd - size) < 0.005 ? existing : await quoteAt(size);
      points.push(makePoint(q.cycle, q.val, evOf(q.cycle, q.val), maxImpactBps));
    } catch (err) {
      onError(size, err);
    }
  }
  return points;
}
