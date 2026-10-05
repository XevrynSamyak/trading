import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { FunnelReader, type OppRecord, type Stage } from "../src/funnel.js";
import { goLiveVerdict, loadGateInput, type GateInput, type GateThresholds } from "../src/gate.js";
import { disableTrading, enableTrading, halted, tradingDisabled } from "../src/killswitch.js";
import { buildReportData } from "../src/report-cli.js";
import { renderReport, riskStatus } from "../src/report.js";
import { LearningStats } from "../src/stats.js";

const T0 = Date.parse("2026-10-05T10:00:00Z");
const DAY = 86_400_000;

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

const sim = (netUsd: number, ok = true) =>
  rec({ stage: ok ? "simulated" : "executable", result: ok ? "filled" : "rejected", simulated: { netUsd, netBps: netUsd * 500, ok } });
const real = (netUsd: number, result: OppRecord["result"] = "filled") =>
  rec({
    mode: "micro",
    stage: result === "timeout" ? "submitted" : netUsd > 0 ? "profitable" : "landed",
    result,
    realized: { netUsd, netBps: netUsd * 500, landed: result !== "timeout", signature: "sig" },
  });

const T: GateThresholds = { minPaperDays: 3, minSimulated: 30, minSimSuccessRate: 0.3, microMinTrades: 20, microMinProfitableRate: 0.7 };
const input = (o: Partial<GateInput>): GateInput => ({ paper: [], micro: [], paperDays: 5, killSwitch: null, halted: null, ...o });
const goodPaper = [...Array.from({ length: 30 }, () => sim(0.01)), ...Array.from({ length: 10 }, () => sim(0, false))];

describe("go-live gate", () => {
  it("says NO to both without evidence, naming what is missing", () => {
    const v = goLiveVerdict(input({ paperDays: 0.5 }), T);
    expect(v.micro.ok).toBe(false);
    expect(v.micro.reasons[0]).toMatch(/no on-chain simulation data yet/);
    expect(v.micro.reasons).toContain("only 0.5 days of paper data (need 3)");
    expect(v.live.ok).toBe(false);
    expect(v.live.reasons).toEqual(["Insufficient real execution sample: 0 MICRO trades landed (need 20)"]);
  });

  it("recommends MICRO only after enough simulated trades succeeded and made money", () => {
    expect(goLiveVerdict(input({ paper: goodPaper }), T).micro).toEqual({ ok: true, reasons: [] });
    // Too few simulated trades.
    expect(goLiveVerdict(input({ paper: goodPaper.slice(0, 10) }), T).micro.reasons).toContain("only 10 trades simulated on-chain (need 30)");
    // Mostly reverted on-chain.
    const reverts = [...goodPaper.slice(0, 5), ...Array.from({ length: 40 }, () => sim(0, false))];
    expect(goLiveVerdict(input({ paper: reverts }), T).micro.reasons.join()).toMatch(/only 11% of simulated trades succeeded/);
    // Succeeded but lost money on average after costs.
    const losers = Array.from({ length: 30 }, () => sim(-0.002));
    expect(goLiveVerdict(input({ paper: losers }), T).micro.reasons.join()).toMatch(/lose money on average/);
    // Quote-only paper results are not evidence at all.
    const quoteOnly = Array.from({ length: 100 }, () => rec({ stage: "executable" }));
    expect(goLiveVerdict(input({ paper: quoteOnly }), T).micro.ok).toBe(false);
  });

  it("allows LIVE only after enough profitable MICRO trades landed with positive P&L", () => {
    const micro = [...Array.from({ length: 16 }, () => real(0.004)), ...Array.from({ length: 4 }, () => real(-0.001))];
    expect(goLiveVerdict(input({ paper: goodPaper, micro }), T).live).toEqual({ ok: true, reasons: [] });

    const few = goLiveVerdict(input({ micro: micro.slice(0, 12) }), T).live;
    expect(few.reasons).toContain("Insufficient real execution sample: 12 MICRO trades landed (need 20)");

    const unprofitable = [...Array.from({ length: 10 }, () => real(0.004)), ...Array.from({ length: 10 }, () => real(-0.001))];
    expect(goLiveVerdict(input({ micro: unprofitable }), T).live.reasons).toContain("only 50% of MICRO trades were profitable (need 70%)");

    const bigLoss = [...micro, real(-0.2)];
    expect(goLiveVerdict(input({ micro: bigLoss }), T).live.reasons.join()).toMatch(/MICRO realized P&L is \$-0\.1400/);

    const timeout = [...micro, real(0, "timeout")];
    expect(goLiveVerdict(input({ micro: timeout }), T).live.reasons).toContain("1 MICRO trade(s) had an unconfirmed landing");
  });

  it("blocks both while trading is disabled or the bot is halted", () => {
    const micro = Array.from({ length: 20 }, () => real(0.004));
    const v = goLiveVerdict(input({ paper: goodPaper, micro, killSwitch: "stopped by hand" }), T);
    expect(v.micro.ok).toBe(false);
    expect(v.live.ok).toBe(false);
    expect(v.live.reasons[0]).toBe("trading is disabled: stopped by hand");
    expect(goLiveVerdict(input({ paper: goodPaper, micro, halted: "loss floor" }), T).live.reasons[0]).toBe("the bot is halted: loss floor");
  });

  it("reads its evidence from the data folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    writeFileSync(join(dir, "opps-paper.jsonl"), goodPaper.map((r) => JSON.stringify(r)).join("\n") + "\n");
    writeFileSync(join(dir, "brain-paper.json"), JSON.stringify({ startedAt: T0 - 4 * DAY }));
    let g = loadGateInput(dir, T0);
    expect(g.paper).toHaveLength(40);
    expect(g.micro).toHaveLength(0);
    expect(g.paperDays).toBeCloseTo(4);
    expect(g.killSwitch).toBeNull();
    expect(g.halted).toBeNull();

    disableTrading(dir, "test stop", new Date(T0));
    writeFileSync(join(dir, "HALTED"), "loss floor hit\n");
    g = loadGateInput(dir, T0);
    expect(g.killSwitch).toBe("2026-10-05T10:00:00.000Z test stop");
    expect(g.halted).toBe("loss floor hit");
  });
});

describe("kill switch", () => {
  it("is set by hand or by the bot, and only lifted by hand", () => {
    const dir = mkdtempSync(join(tmpdir(), "kill-"));
    expect(tradingDisabled(dir)).toEqual({ disabled: false });
    expect(enableTrading(dir)).toBe(false);
    disableTrading(join(dir, "nested"), "unexpected loss", new Date(T0));
    expect(tradingDisabled(join(dir, "nested"))).toEqual({ disabled: true, reason: "2026-10-05T10:00:00.000Z unexpected loss" });
    expect(enableTrading(join(dir, "nested"))).toBe(true);
    expect(tradingDisabled(join(dir, "nested")).disabled).toBe(false);
    expect(halted(dir)).toBeNull();
  });
});

describe("funnel reader for refreshing screens", () => {
  it("parses only complete new lines, and starts over when the file is replaced", () => {
    const path = join(mkdtempSync(join(tmpdir(), "reader-")), "opps-paper.jsonl");
    const r = new FunnelReader(path);
    expect(r.read()).toHaveLength(0);
    writeFileSync(path, JSON.stringify(rec({ id: "a", stage: "quoted" })) + "\n" + JSON.stringify(rec({ id: "b", stage: "quoted" })) + "\n");
    expect(r.read().map((x) => x.id)).toEqual(["a", "b"]);
    // A line still being written is left for next time.
    const c = JSON.stringify(rec({ id: "c", stage: "quoted" }));
    appendFileSync(path, c.slice(0, 40));
    expect(r.read()).toHaveLength(2);
    appendFileSync(path, c.slice(40) + "\n");
    expect(r.read().map((x) => x.id)).toEqual(["a", "b", "c"]);
    writeFileSync(path, JSON.stringify(rec({ id: "z", stage: "quoted" })) + "\n");
    expect(r.read().map((x) => x.id)).toEqual(["z"]);
  });
});

describe("report", () => {
  const verdictNo = {
    micro: { ok: false, reasons: ["only 4 trades simulated on-chain (need 30)"] },
    live: { ok: false, reasons: ["Insufficient real execution sample: 0 MICRO trades landed (need 20)"] },
  };

  it("keeps quoted, executable, simulated and realized apart and never calls quotes profit", () => {
    const opps = [
      rec({ stage: "quoted", result: "stale", executable: { netUsd: -0.01, netBps: -5, grossBps: 0 } }),
      rec({ stage: "simulated", simulated: { netUsd: 0.01, netBps: 5, ok: true }, executable: { netUsd: 0.01, netBps: 6, grossBps: 10 } }),
    ];
    const text = renderReport({
      modeNow: "paper",
      scans: 1234,
      opps,
      stats: LearningStats.fromRecords(opps),
      quotedOnlyUsd: 0.5,
      verdict: verdictNo,
      risk: { level: "GREEN", reasons: [] },
      thoughts: ["thinking"],
      billsLine: "Bills: ...",
    });
    expect(text).toContain("ARBITRAGE BOT REPORT");
    expect(text).toContain("Scanned round trips:          1,234");
    expect(text).toContain("Realized P&L (real money):    +$0.0000");
    expect(text).toContain("Quoted-only results:          +$0.5000  (quotes alone; NOT profit)");
    expect(text).toMatch(/quoted \(not profit\)\s+0\.25%\s+0\.25%\s+2/);
    expect(text).toMatch(/executable \(fresh re-quote\)\s+0\.01%\s+0\.01%\s+2/);
    expect(text).toMatch(/simulated on-chain\s+0\.05%\s+0\.05%\s+1/);
    expect(text).toMatch(/realized\s+n\/a\s+n\/a\s+0/);
    // "Best" uses simulated evidence when there are no real trades; never quotes.
    expect(text).toContain("Best token (simulated):");
    expect(text).toContain("MICRO LIVE: NO");
    expect(text).toContain("FULL LIVE:  NO");
    expect(text).toContain("LIVE: Insufficient real execution sample: 0 MICRO trades landed (need 20)");

    const none = renderReport({
      modeNow: "paper", scans: 0, opps: [], stats: LearningStats.fromRecords([]), quotedOnlyUsd: 0,
      verdict: verdictNo, risk: { level: "GREEN", reasons: [] }, thoughts: [], billsLine: "",
    });
    expect(none).toContain("Best token (no evidence yet): n/a");
  });

  it("rates risk GREEN, AMBER or RED", () => {
    const base = { killSwitch: null, halted: null, todayMoneyPnlUsd: 0, dailyLossLimitUsd: 2, timeoutsToday: 0, walletValueUsd: 25, lossFloorUsd: 17.5 };
    expect(riskStatus(base)).toEqual({ level: "GREEN", reasons: [] });
    expect(riskStatus({ ...base, todayMoneyPnlUsd: -1.2 }).level).toBe("AMBER");
    expect(riskStatus({ ...base, timeoutsToday: 1 }).reasons).toEqual(["1 unconfirmed landing(s) today"]);
    expect(riskStatus({ ...base, walletValueUsd: 18 }).level).toBe("AMBER");
    const red = riskStatus({ ...base, killSwitch: "stopped by hand", timeoutsToday: 1 });
    expect(red.level).toBe("RED");
    expect(red.reasons).toEqual(["trading disabled: stopped by hand", "1 unconfirmed landing(s) today"]);
  });

  it("gathers every mode's files, and labels paper bills as not real money", () => {
    const dir = mkdtempSync(join(tmpdir(), "report-"));
    writeFileSync(join(dir, "opps-paper.jsonl"), [sim(0.01), sim(0.02)].map((r) => JSON.stringify(r)).join("\n") + "\n");
    writeFileSync(join(dir, "opps-micro.jsonl"), JSON.stringify(real(0.003)) + "\n");
    const trade = (o: object) => JSON.stringify({ ts: T0, mode: "paper", symbol: "SOL", status: "filled", inUsd: 20, netUsd: 0.01, feeUsd: 0, ...o });
    writeFileSync(
      join(dir, "trades-paper.jsonl"),
      [trade({ basis: "quoted", netUsd: 0.4, verified: false }), trade({ basis: "simulated", verified: true })].join("\n") + "\n",
    );
    writeFileSync(join(dir, "brain-paper.json"), JSON.stringify({ totalScans: 700, startedAt: T0 - DAY }));
    writeFileSync(join(dir, "brain-micro.json"), JSON.stringify({ totalScans: 50, startedAt: T0 }));
    const d = buildReportData(loadConfig({ DATA_DIR: dir }), T0 + 1000);
    expect(d.scans).toBe(750);
    expect(d.opps).toHaveLength(3);
    expect(d.quotedOnlyUsd).toBeCloseTo(0.4);
    expect(d.billsLine).toContain("simulated on-chain only; NOT real money");
    expect(d.verdict.live.reasons[0]).toBe("Insufficient real execution sample: 1 MICRO trades landed (need 20)");
    expect(renderReport(d)).toContain("Real trades (MICRO/LIVE):     1 sent, 1 landed, 1 profitable, 0 failed");
  });
});
