import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecResult } from "../src/executor.js";
import { Funnel, latencies, stageOf, type OppRecord, type Stage } from "../src/funnel.js";
import { LearningStats, scoreOpportunity, sizeBucket } from "../src/stats.js";

const T0 = Date.parse("2026-10-05T10:00:00Z");

function rec(o: Partial<OppRecord> & { stage: Stage }): OppRecord {
  return {
    id: "opp_x", ts: T0, mode: "paper", kind: "two-leg", symbol: "SOL", tokens: ["SOL"], route: "A | B", sizeUsd: 20,
    quoted: { netUsd: 0.05, netBps: 25, grossBps: 30 }, expected: { pSuccess: 0.5, evUsd: 0.02, assumed: [] },
    costs: { baseFeeUsd: 0, priorityFeeUsd: 0, tipUsd: 0, tipLamports: 0, bufferUsd: 0, totalUsd: 0, dexFeeBps: 0, priceImpactBps: 0 },
    result: "filled", t: { quoteStart: T0, quoteEnd: T0 + 300, decision: T0 + 301 },
    lat: { quoteMs: 300, quoteToDecisionMs: 1, totalMs: 301 },
    ...o,
  };
}

describe("opportunity funnel", () => {
  it("gives daily IDs and continues numbering after a restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "funnel-")), "opps-paper.jsonl");
    const f = new Funnel(path);
    expect(f.nextId(T0)).toBe("opp_20261005_000001");
    const id2 = f.nextId(T0);
    f.record(rec({ id: id2, stage: "quoted" }));
    expect(new Funnel(path).nextId(T0)).toBe("opp_20261005_000003");
    expect(new Funnel(path).nextId(T0 + 86_400_000)).toBe("opp_20261006_000001");
    expect(Funnel.read(path)).toHaveLength(1);
  });

  it("knows how far each outcome got", () => {
    const r = (o: Partial<ExecResult>): ExecResult => ({ status: "filled", netUsd: 0, feeUsd: 0, t: {}, ...o });
    expect(stageOf(r({ status: "stale" }), false)).toBe("quoted");
    expect(stageOf(r({ status: "filled", verified: false }), false)).toBe("executable"); // quote-only
    expect(stageOf(r({ status: "rejected", verified: true }), false)).toBe("executable");
    expect(stageOf(r({ status: "filled", verified: true }), false)).toBe("simulated");
    expect(stageOf(r({ status: "rejected", signature: "s" }), true)).toBe("submitted"); // sent, never landed
    expect(stageOf(r({ status: "failed", signature: "s" }), true)).toBe("landed");
    expect(stageOf(r({ status: "filled", signature: "s", netUsd: 0.02 }), true)).toBe("profitable");
    expect(stageOf(r({ status: "filled", signature: "s", netUsd: -0.01 }), true)).toBe("landed");
  });

  it("measures latency between stages", () => {
    const lat = latencies({ market: 0, quoteStart: 50, quoteEnd: 250, decision: 260, submitted: 900, landed: 1700 });
    expect(lat).toEqual({ marketToQuoteMs: 250, quoteMs: 200, quoteToDecisionMs: 10, decisionToSubmitMs: 640, submitToLandingMs: 800, totalMs: 1700 });
  });
});

describe("learning engine V2", () => {
  it("learns the fake-opportunity rate per token, shrunk toward the global rate", () => {
    const records = [
      ...Array.from({ length: 20 }, () => rec({ symbol: "BONK", stage: "quoted", result: "stale", executable: { netUsd: -0.01, netBps: -5, grossBps: 0 } })),
      ...Array.from({ length: 20 }, () => rec({ symbol: "JUP", stage: "executable", executable: { netUsd: 0.03, netBps: 15, grossBps: 20 } })),
    ];
    const s = LearningStats.fromRecords(records);
    const bonk = s.probabilities("BONK", undefined, "paper", false);
    const jup = s.probabilities("JUP", undefined, "paper", false);
    const fresh = s.probabilities("NEW", undefined, "paper", false);
    expect(bonk.executable).toBeLessThan(0.15);
    expect(jup.executable).toBeGreaterThan(0.85);
    expect(fresh.executable).toBeCloseTo(0.5, 1); // no own data: the global rate
    expect(bonk.assumed).toEqual([]);
  });

  it("uses labelled assumptions for steps with no data (landing before any real trade)", () => {
    const s = LearningStats.fromRecords([rec({ stage: "simulated", simulated: { netUsd: 0.04, netBps: 20, ok: true } })]);
    const p = s.probabilities("SOL", undefined, "micro", true);
    expect(p.assumed).toContain("landing");
    expect(p.landing).toBe(0.5);
    expect(p.success).toBeCloseTo(p.executable * p.simulation * p.landing * p.profit, 9);
  });

  it("records realized results and computes EV including failed-landing costs", () => {
    const s = LearningStats.fromRecords([
      rec({ mode: "micro", stage: "profitable", realized: { netUsd: 0.03, netBps: 15, landed: true, signature: "a" } }),
      rec({ mode: "micro", stage: "landed", result: "failed", realized: { netUsd: -0.002, netBps: -1, landed: true, signature: "b" } }),
    ]);
    expect(s.global.landed).toBe(2);
    expect(s.global.profitable).toBe(1);
    expect(s.global.realizedUsd).toBeCloseTo(0.028, 9);
    const p = s.probabilities("SOL", undefined, "micro", true);
    const ev = s.expectedValue(0.05, 0.002, p, "micro", true);
    const reach = p.executable * p.simulation * p.landing;
    expect(ev).toBeCloseTo(reach * (p.profit * 0.05 - (1 - p.profit) * 0.002), 12);
    expect(s.table()[0]).toMatchObject({ symbol: "SOL", n: 2, realKind: "realized" });
  });

  it("buckets sizes for statistics", () => {
    expect(sizeBucket(20)).toBe("<=25");
    expect(sizeBucket(742)).toBe("<=1000");
    expect(sizeBucket(9_000)).toBe(">5000");
  });
});

describe("opportunity score", () => {
  const base = { evUsd: 1, quoteAgeMs: 0, expectedLatencyMs: 0, priceImpactBps: 0, maxImpactBps: 100, discovered: false };
  it("prefers fresh, fast, low-impact, known-token opportunities", () => {
    expect(scoreOpportunity(base)).toBe(1);
    expect(scoreOpportunity({ ...base, quoteAgeMs: 1_000 })).toBeCloseTo(0.5, 9);
    expect(scoreOpportunity({ ...base, expectedLatencyMs: 2_000 })).toBeCloseTo(0.5, 9);
    expect(scoreOpportunity({ ...base, priceImpactBps: 50 })).toBeCloseTo(0.5, 9);
    expect(scoreOpportunity({ ...base, discovered: true })).toBeCloseTo(0.8, 9);
    expect(scoreOpportunity({ ...base, priceImpactBps: 150 })).toBe(0);
    expect(scoreOpportunity({ ...base, evUsd: -0.1 })).toBe(-0.1); // never turns negative EV positive
  });
});
