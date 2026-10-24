import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderBacktest } from "../src/backtest.js";
import { GapMemory, ProbeBudget, ProbeLog, gapBucket, held, probeFromOpp, venuesOf, type ProbeRecord } from "../src/probes.js";
import { mixThoughts } from "../src/status.js";

const T0 = Date.parse("2026-10-24T10:00:00Z");
const probe = (o: Partial<ProbeRecord> = {}): ProbeRecord => ({
  ts: T0, symbol: "JUP", kind: "two-leg", venues: ["Whirlpool"], sizeUsd: 20,
  quotedBps: 4, freshBps: -8, ageMs: 400, event: false, ...o,
});

describe("probes", () => {
  it("reads the venues of a route and judges whether a gap held", () => {
    expect(venuesOf("Obsidian>Whirlpool | Bonkswap>Whirlpool")).toEqual(["Obsidian", "Whirlpool", "Bonkswap"]);
    expect(venuesOf("GoonFi V2 | Raydium CLMM")).toEqual(["GoonFi V2", "Raydium CLMM"]);
    expect(held({ quotedBps: 10, freshBps: 6 })).toBe(true);
    expect(held({ quotedBps: 10, freshBps: 4 })).toBe(false); // shrank by more than half
    expect(held({ quotedBps: 3, freshBps: -1 })).toBe(false);
    expect(gapBucket(3)).toBe("0..5");
    expect(gapBucket(25)).toBe("20..50");
    expect(gapBucket(248)).toBe("50+");
  });

  it("counts re-quoted opportunities with the same test, and skips ones never re-quoted", () => {
    const opp = {
      ts: T0, symbol: "WIF", kind: "two-leg" as const, route: "A | B", sizeUsd: 20,
      quoted: { netBps: 44.1 }, executable: { netBps: -30.3 },
      t: { quoteEnd: T0, requoteEnd: T0 + 846, market: T0 - 20 },
    };
    expect(probeFromOpp(opp)).toEqual({
      ts: T0, symbol: "WIF", kind: "two-leg", venues: ["A", "B"], sizeUsd: 20, quotedBps: 44.1, freshBps: -30.3, ageMs: 846, event: true,
    });
    expect(probeFromOpp({ ...opp, executable: undefined })).toBeNull();
  });

  it("learns which venues' gaps are real and trusts the others less (never more)", () => {
    const probes = [
      ...Array.from({ length: 30 }, (_, i) => probe({ venues: ["GoonFi V2"], freshBps: i < 1 ? 3 : -9 })),
      ...Array.from({ length: 30 }, (_, i) => probe({ venues: ["Whirlpool"], freshBps: i < 15 ? 3 : -9 })),
    ];
    const m = GapMemory.from(probes);
    expect(m.venueTrust(["GoonFi V2"])).toBeLessThan(0.3);
    expect(m.venueTrust(["Whirlpool"])).toBe(1);
    expect(m.venueTrust(["Unknown DEX"])).toBe(1);
    expect(m.venueTrust(["Whirlpool", "GoonFi V2"])).toBeLessThan(0.3); // the weakest venue on the route counts
    expect(GapMemory.from(probes.slice(0, 5)).venueTrust(["GoonFi V2"])).toBe(1); // too few examples to judge
    const thoughts = m.thoughts().join("\n");
    expect(thoughts).toMatch(/I re-checked 60 gaps: 27% were still there/);
    expect(thoughts).toMatch(/Gaps through GoonFi V2 held 3% vs 50% through Whirlpool, so I trust GoonFi V2 less/);
  });

  it("notices that big quoted gaps are mostly stale, and compares triggers and re-check speed", () => {
    const m = GapMemory.from([
      ...Array.from({ length: 12 }, () => probe({ quotedBps: 60, freshBps: -10, ageMs: 1_500 })),
      ...Array.from({ length: 12 }, () => probe({ quotedBps: 3, freshBps: 2, event: true, ageMs: 300 })),
    ]);
    const t = m.thoughts().join("\n");
    expect(t).toMatch(/Big quoted gaps \(20\+ bps\) held only 0% of the time/);
    expect(t).toMatch(/right after a pool change held 100%; found by routine scans, 0%/);
    expect(t).toMatch(/within half a second, 100% held; after a second or more, 0%/);
    expect(m.table()).toEqual([
      { bucket: "0..5", n: 12, heldPct: 100, avgDecayBps: 1 },
      { bucket: "50+", n: 12, heldPct: 0, avgDecayBps: 70 },
    ]);
    expect(GapMemory.from([probe()]).thoughts()).toEqual(["I've re-checked 1 gap(s) so far; I need 10+ to judge them."]);
  });

  it("paces probes per hour, logs them apart, and feeds the backtest", () => {
    const b = new ProbeBudget(2);
    expect([b.allow(T0), b.allow(T0 + 1), b.allow(T0 + 2)]).toEqual([true, true, false]);
    expect(b.allow(T0 + 3_600_001)).toBe(true);

    const path = join(mkdtempSync(join(tmpdir(), "probes-")), "probes-paper.jsonl");
    const log = new ProbeLog(path);
    log.append(probe());
    log.append(probe({ quotedBps: 8, freshBps: 7 }));
    expect(ProbeLog.read(path)).toHaveLength(2);
    const text = renderBacktest([], ProbeLog.read(path));
    expect(text).toMatch(/Gaps below the bar, re-checked by probes \(2; learning only, nothing traded\)/);
    expect(text).toMatch(/quoted 0\.\.5\s+bps:\s+0% still there\s+\(n=1\)/);
    expect(text).toMatch(/quoted 5\.\.10\s+bps:\s+100% still there\s+\(n=1\)/);
  });

  it("shows the brain's own thoughts and the re-check lessons side by side", () => {
    expect(mixThoughts(["b1", "b2", "b3"], ["g1"])).toEqual(["b1", "g1", "b2", "b3"]);
  });
});
