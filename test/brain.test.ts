import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Brain } from "../src/brain.js";

const tokens = { A: "a", B: "b", C: "c", D: "d" };
const tmp = () => join(mkdtempSync(join(tmpdir(), "brain-")), "brain.json");

describe("Brain", () => {
  it("tries every token first, then focuses on the ones with an edge", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20, tokensPerCycle: 2, exploreRate: 0 });
    for (let i = 0; i < 20; i++) {
      b.observeScan("A", -30);
      b.observeScan("B", 15);
      b.observeScan("C", -40);
      b.observeScan("D", 5);
    }
    expect(Object.keys(b.pickTokens(tokens)).sort()).toEqual(["B", "D"]);
  });

  it("gets pickier after failures and looser after wins, within bounds", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20 });
    b.observeTrade("A", "failed", -0.001);
    expect(b.minProfitBps).toBe(25);
    for (let i = 0; i < 50; i++) b.observeTrade("A", "filled", 0.01);
    expect(b.minProfitBps).toBe(10); // floor = base / 2
    for (let i = 0; i < 50; i++) b.observeTrade("A", "failed", -0.001);
    expect(b.minProfitBps).toBe(80); // ceiling = base * 4
  });

  it("remembers what it learned across restarts", () => {
    const path = tmp();
    const b = new Brain(path, { baseMinProfitBps: 20 });
    b.observeTrade("A", "failed", -0.001);
    b.save();
    expect(new Brain(path, { baseMinProfitBps: 20 }).minProfitBps).toBe(25);
  });
});

describe("Brain: smarter skills", () => {
  it("tries each trade size, then sticks with the one that nets the most dollars", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20, exploreRate: 0 });
    // warm-up: untested sizes come first
    expect(b.pickSize("A", 20).bucket).toBe(0.25);
    const net: Record<number, number> = { 0.25: -0.001, 0.5: 0.004, 1: -0.01 };
    for (let i = 0; i < 10; i++) {
      const { bucket } = b.pickSize("A", 20);
      b.observeScan("A", 0, net[bucket], bucket, 0);
    }
    expect(b.pickSize("A", 20)).toEqual({ usd: 10, bucket: 0.5 });
  });

  it("never picks a size below $1", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20 });
    expect(b.pickSize("A", 2)).toEqual({ usd: 2, bucket: 1 });
  });

  it("scans faster when a gap is close and slower when nothing is", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20, minMsPerRequest: 1_000 });
    // A full scan is 6 requests at the learned 1333ms each = ~8s minimum.
    expect(b.nextIntervalMs(18, 15_000, 0, 0, 6)).toBe(7_998); // near a gap: 7.5s, held to the pace
    expect(b.nextIntervalMs(5, 15_000, 0, 0, 6)).toBe(15_000);
    expect(b.nextIntervalMs(-50, 15_000, 0, 0, 6)).toBe(22_500); // far away -> slow down
  });

  it("learns which hours are good", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20 });
    for (let h = 0; h < 8; h++) b.observeScan("A", -20 - h, 0, 1, h); // -20 .. -27
    b.observeScan("A", 10, 0, 1, 14);
    expect(b.isGoodHour(14)).toBe(true);
    expect(b.isGoodHour(7)).toBe(false);
    expect(b.isGoodHour(20)).toBeNull(); // never seen
    expect(b.nextIntervalMs(5, 15_000, 14)).toBe(12_000);
  });

  it("adds discovered tokens, keeps configured ones, and forgets useless finds", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20 });
    const configured = { SOL: "sol-mint" };
    const added = b.learnTokens({ SOL: "sol-mint", NEW: "new-mint", MORE: "more-mint" }, configured, 2);
    expect(added).toEqual(["NEW"]); // SOL already known; cap of 2 reached
    expect(Object.keys(b.tokenPool(configured)).sort()).toEqual(["NEW", "SOL"]);

    for (let i = 0; i < 60; i++) b.observeScan("NEW", -50);
    b.learnTokens({ MORE: "more-mint" }, configured, 2);
    expect(Object.keys(b.tokenPool(configured)).sort()).toEqual(["MORE", "SOL"]);
  });

  it("upgrades an old brain file without losing what it learned", () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({ tokens: { A: { scans: 5, avgEdgeBps: -3, fills: 0, failures: 0, pnlUsd: 0 } }, minProfitBps: 25, totalScans: 5 }));
    const b = new Brain(path, { baseMinProfitBps: 20 });
    expect(b.minProfitBps).toBe(25);
    expect(b.state.hourEdgeBps).toHaveLength(24);
    expect(() => b.pickSize("A", 20)).not.toThrow();
    expect(b.summary()).toContain("A: edge -3.0bps");
  });
});

describe("Brain: fake gaps and the gap histogram", () => {
  it("trusts tokens with fake gaps less, without getting pickier overall", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20 });
    for (const sym of ["A", "B"]) for (let i = 0; i < 20; i++) b.observeScan(sym, 0);
    for (let i = 0; i < 5; i++) b.observeTrade("A", "rejected", 0);
    expect(b.score("A")).toBeLessThan(b.score("B"));
    expect(b.minProfitBps).toBe(20);
    expect(b.summary()).toContain("5 fake gaps");
  });

  it("keeps a histogram of how close the best gap got", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20 });
    [-30, -3, -2, 7].forEach((bps) => b.observeCycle(bps));
    expect(b.state.edgeHistogram).toEqual({ "< -20": 1, "-5..0": 2, "5..10": 1 });
    expect(b.summary()).toContain("-5..0: 50.0%");
  });
});

describe("Brain: reality checks, sudden moves, and thoughts", () => {
  const T0 = Date.parse("2026-10-04T14:00:00Z");

  it("learns how much a token's quotes overstate reality and discounts them", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20, exploreRate: 0 });
    for (let i = 0; i < 5; i++) b.observeReality("A", 25, 0); // quoted 25bps, really nothing (fake)
    expect(b.expectedNetBps("A", 25)).toBeLessThan(5);
    expect(b.shouldAttempt("A", 25)).toBe(false);
    expect(b.shouldAttempt("B", 25)).toBe(true); // no evidence against B
  });

  it("never inflates a quote, even if reality beat it", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20 });
    b.observeReality("A", 20, 30);
    expect(b.expectedNetBps("A", 20)).toBe(20);
  });

  it("still re-checks a discounted token now and then", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20, exploreRate: 0.2, random: () => 0.1 });
    for (let i = 0; i < 5; i++) b.observeReality("A", 25, 0);
    expect(b.shouldAttempt("A", 25)).toBe(true);
    expect(b.shouldAttempt("A", 10)).toBe(false); // below the bar even before discounting
  });

  it("marks a token hot after a sudden move, scans it first and faster", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20, tokensPerCycle: 1, exploreRate: 0 });
    for (let i = 0; i < 10; i++) { b.observeScan("A", 5); b.observeScan("Z", -40); }
    expect(b.observePrice("Z", 1, 100, T0)).toBeNull(); // first sighting
    expect(b.observePrice("Z", 0.5, 101, T0 + 10_000)).toBeNull(); // different size: not comparable
    expect(b.observePrice("Z", 1, 100.5, T0 + 20_000)).toBeCloseTo(50, 6); // +0.5% in 20s
    expect(b.isHot("Z", T0 + 30_000)).toBe(true);
    expect(Object.keys(b.pickTokens({ A: "a", Z: "z" }, T0 + 30_000))).toEqual(["Z"]);
    expect(b.nextIntervalMs(5, 15_000, 0, T0 + 30_000)).toBe(9_000);
    expect(b.isHot("Z", T0 + 3 * 60_000)).toBe(false); // cools down after 2 minutes
    expect(b.state.hotEvents).toBe(1);
  });

  it("ignores small moves and stale comparisons", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20 });
    b.observePrice("A", 1, 100, T0);
    b.observePrice("A", 1, 100.1, T0 + 10_000); // 10bps: normal noise
    b.observePrice("A", 1, 110, T0 + 20 * 60_000); // big, but 20 minutes later
    expect(b.isHot("A", T0 + 20 * 60_000)).toBe(false);
  });

  it("explains itself in plain language", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20 });
    b.observeCycle(-3, "SOL", T0);
    b.observeCycle(4.1, "WIF", T0 + 60_000);
    for (let i = 0; i < 4; i++) b.observeReality("SOL", 22, 10);
    b.observePrice("JUP", 1, 100, T0);
    b.observePrice("JUP", 1, 101, T0 + 30_000);
    const text = b.thoughts(20).join("\n");
    expect(text).toContain("at least 20bps (0.20%)");
    expect(text).toContain("closest I've come is WIF at 4.1bps");
    expect(text).toContain("SOL's quotes look ~12.0bps better");
    expect(text).toContain("JUP moving 1.00% within minutes");
  });

  it("upgrades a brain file from the previous version", () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({
      tokens: { A: { scans: 5, avgEdgeBps: -3, fills: 0, failures: 0, pnlUsd: 0, phantoms: 2, sizes: {} } },
      minProfitBps: 20, totalScans: 5, hourEdgeBps: Array(24).fill(null), discovered: {}, edgeHistogram: {}, startedAt: 1,
    }));
    const b = new Brain(path, { baseMinProfitBps: 20 });
    expect(b.expectedNetBps("A", 10)).toBe(10);
    expect(b.state.hotEvents).toBe(0);
    expect(b.thoughts(20).length).toBeGreaterThan(0);
  });
});

describe("Brain: learns the fastest safe scan pace", () => {
  it("speeds up after clean scans, slows down on a rate limit, never below the budget", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20, minMsPerRequest: 1_035 });
    expect(b.msPerRequest).toBe(1_333);
    for (let i = 0; i < 10; i++) b.observePace(false);
    expect(b.msPerRequest).toBe(1_200);
    b.observePace(true);
    expect(b.msPerRequest).toBe(2_400);
    for (let i = 0; i < 500; i++) b.observePace(false);
    expect(b.msPerRequest).toBe(1_035); // the even spacing for 60 requests/min
    expect(b.scanPaceMs(6)).toBe(6_210); // full scan
    expect(b.scanPaceMs(2)).toBe(2_070); // focus scan of one token
  });

  it("remembers its pace across restarts, and converts an older brain's per-scan pace", () => {
    const path = tmp();
    const b = new Brain(path, { baseMinProfitBps: 20 });
    b.observePace(true);
    b.save();
    expect(new Brain(path, { baseMinProfitBps: 20 }).msPerRequest).toBe(2_666);

    const old = tmp();
    writeFileSync(old, JSON.stringify({ tokens: {}, minProfitBps: 20, totalScans: 0, paceFloorMs: 12_800 }));
    const upgraded = new Brain(old, { baseMinProfitBps: 20 });
    expect(upgraded.msPerRequest).toBeCloseTo(2_133.3, 1);
    expect("paceFloorMs" in upgraded.state).toBe(false);
  });
});

describe("Brain: focus mode", () => {
  const T0 = Date.parse("2026-10-04T14:00:00Z");
  const all = { A: "a", B: "b", C: "c", D: "d" };

  it("re-checks a moving token on its own twice, then does a full scan, while it stays hot", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20, exploreRate: 0, minMsPerRequest: 1_035 });
    for (let i = 0; i < 6; i++) b.observePace(false); // (not enough to change pace)
    b.observePrice("D", 1, 100, T0);
    b.observePrice("D", 1, 101, T0 + 5_000); // +1% in 5s -> hot
    const t = T0 + 6_000;
    expect(b.plannedRequests(t)).toBe(2);
    expect(Object.keys(b.pickTokens(all, t))).toEqual(["D"]);
    expect(Object.keys(b.pickTokens(all, t))).toEqual(["D"]);
    expect(b.plannedRequests(t)).toBe(6);
    expect(Object.keys(b.pickTokens(all, t))).toHaveLength(3); // full scan, D included first
    expect(Object.keys(b.pickTokens(all, t))).toEqual(["D"]); // focus again
    // a focus scan can follow ~3x sooner than a full one
    expect(b.nextIntervalMs(-3, 1_000, 0, t, 2)).toBe(2_666);
    expect(b.nextIntervalMs(-3, 1_000, 0, t, 6)).toBe(7_998);
  });

  it("focuses on a token whose gap is nearly big enough, for a minute", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20, exploreRate: 0 });
    b.observeCycle(16, "B", T0); // 4bps short of the 20bps bar
    expect(b.isHot("B", T0 + 59_000)).toBe(true);
    expect(Object.keys(b.pickTokens(all, T0 + 1_000))).toEqual(["B"]);
    expect(b.isHot("B", T0 + 61_000)).toBe(false);
    b.observeCycle(10, "C", T0); // 10bps short: not close enough
    expect(b.isHot("C", T0 + 1_000)).toBe(false);
    expect(b.state.hotEvents).toBe(0); // near-gaps are not counted as price-move events
  });

  it("does normal scans when nothing is hot", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20, exploreRate: 0 });
    expect(b.plannedRequests(T0)).toBe(6);
    expect(Object.keys(b.pickTokens(all, T0))).toHaveLength(3);
  });
});
