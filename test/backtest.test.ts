import { describe, expect, it } from "vitest";
import { outcomeOf, renderBacktest, scenarios, sizePolicies, survivalByAge } from "../src/backtest.js";
import type { OppRecord, Stage } from "../src/funnel.js";

const T0 = Date.parse("2026-10-05T10:00:00Z");

function rec(o: Partial<OppRecord> & { stage: Stage }): OppRecord {
  return {
    id: "opp_x", ts: T0, mode: "paper", kind: "two-leg", symbol: "SOL", tokens: ["SOL"], route: "A | B", sizeUsd: 20,
    quoted: { netUsd: 0.05, netBps: 25, grossBps: 30 }, expected: { pSuccess: 0.5, evUsd: 0.02, assumed: [] },
    costs: { baseFeeUsd: 0, priorityFeeUsd: 0, tipUsd: 0, tipLamports: 0, bufferUsd: 0, totalUsd: 0, dexFeeBps: 0, priceImpactBps: 5 },
    result: "filled", t: { quoteStart: T0, quoteEnd: T0 + 300, decision: T0 + 301 },
    lat: { quoteMs: 300, quoteToDecisionMs: 1, totalMs: 301 },
    ...o,
  };
}
const stale = (o: Partial<OppRecord> = {}) => rec({ stage: "quoted", result: "stale", ...o });
const sim = (netUsd: number, o: Partial<OppRecord> = {}) =>
  rec({ stage: "simulated", simulated: { netUsd, netBps: netUsd * 500, ok: true }, executable: { netUsd, netBps: 5, grossBps: 9 }, ...o });

describe("backtest", () => {
  it("adds up an outcome, preferring realized over simulated money, never quotes", () => {
    const o = outcomeOf([stale(), sim(0.01), sim(-0.002)]);
    expect(o).toMatchObject({ acted: 3, executable: 2, simulatedOk: 2, landed: 0, moneyBasis: "simulated" });
    expect(o.moneyUsd).toBeCloseTo(0.008);
    expect(o.quotedUsd).toBeCloseTo(0.15);
    const real = outcomeOf([
      rec({ mode: "micro", stage: "profitable", realized: { netUsd: 0.004, netBps: 2, landed: true } }),
      sim(1),
    ]);
    expect(real).toMatchObject({ moneyBasis: "realized", landed: 1, profitable: 1 });
    expect(real.moneyUsd).toBeCloseTo(0.004);
    expect(outcomeOf([stale()]).moneyBasis).toBe("none");
  });

  it("offers stricter rules, kinds, triggers and leaving out the worst token", () => {
    const opps = [
      sim(0.02, { quoted: { netUsd: 0.2, netBps: 120, grossBps: 130 }, symbol: "JUP" }),
      sim(-0.01, { symbol: "WIF" }),
      sim(-0.01, { symbol: "WIF", kind: "triangle" }),
      stale({ t: { market: T0 - 50, quoteStart: T0, quoteEnd: T0 + 300, decision: T0 + 301 } }),
    ];
    const names = scenarios(opps).map((s) => s.name);
    expect(names).toEqual([
      "as recorded",
      "quoted net >= 30bps",
      "quoted net >= 50bps",
      "quoted net >= 100bps",
      "expected value >= $0.005",
      "expected value >= $0.02",
      "price impact <= 10bps",
      "price impact <= 30bps",
      "quote <= 500ms old at decision",
      "two-leg only",
      "triangle only",
      "event-triggered only",
      "polled only",
      "without WIF",
    ]);
    const strict = scenarios(opps).find((s) => s.name === "quoted net >= 100bps")!;
    expect(outcomeOf(opps.filter(strict.keep)).moneyUsd).toBeCloseTo(0.02);
  });

  it("shows how fast gaps die and compares size policies on quotes only", () => {
    const at = (age: number, still: boolean) => {
      const t = { quoteStart: T0, quoteEnd: T0 + 300, decision: T0 + 301, requoteEnd: T0 + 300 + age };
      return still ? sim(0.01, { t }) : stale({ t });
    };
    const opps = [at(100, true), at(150, true), at(400, false), at(3_000, false), at(3_500, true)];
    expect(survivalByAge(opps)).toEqual([
      { bucket: "< 250 ms", n: 2, stillThere: 2 },
      { bucket: "250-500 ms", n: 1, stillThere: 0 },
      { bucket: "2000-5000 ms", n: 2, stillThere: 1 },
    ]);
    const laddered = rec({
      stage: "executable",
      quoted: { netUsd: 0.03, netBps: 15, grossBps: 20 },
      ladder: [
        { sizeUsd: 10, netUsd: 0.01, netBps: 10, evUsd: 0.005, impactBps: 1 },
        { sizeUsd: 20, netUsd: 0.03, netBps: 15, evUsd: 0.015, impactBps: 2 },
        { sizeUsd: 50, netUsd: 0.02, netBps: 4, evUsd: 0.01, impactBps: 8 },
      ],
    });
    expect(sizePolicies([laddered])).toEqual([
      { name: "size the ladder chose", n: 1, quotedUsd: 0.03 },
      { name: "always the smallest size", n: 1, quotedUsd: 0.01 },
      { name: "always the largest size", n: 1, quotedUsd: 0.02 },
    ]);
  });

  it("renders honestly, including when there is nothing to judge", () => {
    expect(renderBacktest([])).toMatch(/Nothing recorded yet/);
    const quoteOnly = renderBacktest([stale(), rec({ stage: "executable" })]);
    expect(quoteOnly).toMatch(/No on-chain results yet/);
    expect(quoteOnly).toMatch(/as recorded\s+2\s+50%\s+0\s+0\s+n\/a\s+\+\$0\.1000/);
    expect(quoteOnly).toMatch(/Looser rules can't be judged/);
  });
});
