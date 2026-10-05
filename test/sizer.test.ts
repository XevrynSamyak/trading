import { describe, expect, it } from "vitest";
import type { Valuation } from "../src/costs.js";
import type { Cycle } from "../src/cycle.js";
import { evaluateLadder, ladderSizes, makePoint, pickBestSize } from "../src/sizer.js";

const LADDER = [10, 25, 50, 100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000];

const fake = (sizeUsd: number, netUsd: number, impactBps = 0): { cycle: Cycle; val: Valuation } => ({
  cycle: { priceImpactBps: impactBps } as Cycle,
  val: { inUsd: sizeUsd, netUsd, netBps: (netUsd / sizeUsd) * 10_000 } as Valuation,
});

describe("which sizes to try", () => {
  it("stays within the wallet/exposure/MICRO limit and always includes the largest allowed", () => {
    expect(ladderSizes(LADDER, { maxUsd: 20.04, minUsd: 1 }, 4)).toEqual([10, 20.04]);
    expect(ladderSizes(LADDER, { maxUsd: 5, minUsd: 1 }, 4)).toEqual([5]); // MICRO cap
    expect(ladderSizes(LADDER, { maxUsd: 0.5, minUsd: 1 }, 4)).toEqual([]);
  });

  it("thins a long ladder to evenly spread points and keeps the size already quoted", () => {
    const sizes = ladderSizes(LADDER, { maxUsd: 5000, minUsd: 1 }, 4, 750);
    expect(sizes).toHaveLength(4);
    expect(sizes).toContain(10);
    expect(sizes).toContain(5000);
    expect(sizes).toContain(750);
    expect(ladderSizes(LADDER, { maxUsd: 5000, minUsd: 1 }, 1, 750)).toEqual([750]);
  });
});

describe("choosing the size", () => {
  it("when profit keeps rising with size, takes the larger size", () => {
    const pts = [fake(100, 1), fake(500, 4), fake(1000, 7)].map((q) => makePoint(q.cycle, q.val, q.val.netUsd, 100));
    expect(pickBestSize(pts)?.sizeUsd).toBe(1000);
  });

  it("when bigger trades eventually earn less, picks the peak — not the largest", () => {
    const curve: [number, number][] = [[100, 1.4], [500, 7.2], [1000, 12.3], [1500, 15.2], [2000, 15.8], [3000, 12.4]];
    const pts = curve.map(([s, p]) => makePoint(fake(s, p).cycle, fake(s, p).val, p, 100));
    expect(pickBestSize(pts)?.sizeUsd).toBe(2000);
  });

  it("maximises expected value, not raw profit: a reliable $5 beats an unlikely $30", () => {
    const reliable = makePoint(fake(500, 5).cycle, fake(500, 5).val, 5 * 0.9, 100);
    const unlikely = makePoint(fake(3000, 30).cycle, fake(3000, 30).val, 30 * 0.05, 100);
    expect(pickBestSize([reliable, unlikely])?.sizeUsd).toBe(500);
  });

  it("rejects sizes with too much price impact or no positive EV", () => {
    const tooBig = makePoint(fake(5000, 50, 180).cycle, fake(5000, 50, 180).val, 50, 100);
    const losing = makePoint(fake(100, -0.1).cycle, fake(100, -0.1).val, -0.1, 100);
    expect(tooBig.feasible).toBe(false);
    expect(tooBig.reason).toMatch(/price impact/);
    expect(losing.feasible).toBe(false);
    expect(pickBestSize([tooBig, losing])).toBeUndefined();
  });

  it("evaluates each size once, reusing the quote it already has", async () => {
    const asked: number[] = [];
    const pts = await evaluateLadder(
      [10, 20],
      async (usd) => {
        asked.push(usd);
        return fake(usd, usd * 0.002);
      },
      (_c, v) => v.netUsd,
      100,
      fake(20, 0.05),
    );
    expect(asked).toEqual([10]);
    expect(pts.map((p) => p.sizeUsd)).toEqual([10, 20]);
    expect(pickBestSize(pts)?.sizeUsd).toBe(20);
  });
});
