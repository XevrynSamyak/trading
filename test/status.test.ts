import { describe, expect, it } from "vitest";
import { bar, duration, renderStatus, resultsOf, type StatusInput } from "../src/status.js";

const now = Date.parse("2026-10-05T12:00:00Z");
const base: StatusInput = {
  now,
  live: {
    pid: 123, mode: "paper", startedAt: now - 2 * 3600_000 - 13 * 60_000, updatedAt: now - 5_000, cycles: 512,
    state: "scanning", onChainTesting: true, sendVia: "jito", solPrice: 121.6, walletValueUsd: 25,
    tradeSizeUsd: 20, lastBest: { symbol: "SOL", netBps: -0.8, expectedBps: -0.8, needBps: 20 }, hot: ["BONK"],
    nextScanInMs: 15_000,
  },
  processAlive: true,
  halted: null,
  killSwitch: null,
  results: resultsOf([], Date.parse("2026-10-05T12:00:00Z")),
  brainStartedAt: now - 1.5 * 86_400_000,
  paperDaysTarget: 3,
  verdict: {
    micro: { ok: false, reasons: ["only 4 trades simulated on-chain (need 30)", "only 1.5 days of paper data (need 3)"] },
    live: { ok: false, reasons: ["Insufficient real execution sample: 0 MICRO trades landed (need 20)"] },
  },
  edgeHistogram: { "-5..0": 8, "-20..-5": 2 },
  thoughts: ["I only trade when a gap pays at least 20bps (0.20%) after fees."],
  events: ["[2026-10-05T10:00:00Z] Started in PAPER mode"],
  color: false,
};

describe("status screen", () => {
  it("shows a running bot, what it is doing, and test progress", () => {
    const text = renderStatus(base);
    expect(text).toContain("● RUNNING  (paper, tested on-chain)  up 2h 13m, 512 scans");
    expect(text).toContain("scanning, next scan in 10s");
    expect(text).toContain("Last:    SOL -0.8bps, need 20");
    expect(text).toContain("Hot:     BONK");
    expect(text).toContain("Test:    [██████████░░░░░░░░░░] 1.5 / 3 days");
    expect(text).toContain("Go live? MICRO: NO  LIVE: NO");
    // While paper testing, the next hurdle is MICRO's.
    expect(text).toContain("         only 4 trades simulated on-chain (need 30)");
    expect(text).not.toContain("Trading: ■ DISABLED");
    expect(text).toContain("-5..0    ████████████████░░░░ 80.0%");
    expect(text).toContain("Brain thinks");
    expect(text).toContain("Started in PAPER mode");
  });

  it("says when the bot stopped, got stuck, halted, or never started", () => {
    expect(renderStatus({ ...base, processAlive: false })).toContain("■ STOPPED");
    expect(renderStatus({ ...base, live: { ...base.live!, state: "stopped" } })).toContain("■ STOPPED");
    expect(renderStatus({ ...base, live: { ...base.live!, updatedAt: now - 10 * 60_000 } })).toContain("● STUCK?");
    expect(renderStatus({ ...base, halted: "loss floor hit" })).toContain("■ HALTED  loss floor hit");
    expect(renderStatus({ ...base, live: null, processAlive: false })).toContain("NOT STARTED YET");
  });

  it("shows the kill switch, MICRO mode, and LIVE's hurdle once real trades run", () => {
    const off = renderStatus({
      ...base,
      killSwitch: "2026-10-05T11:00:00Z a single trade lost $0.0800",
      live: { ...base.live!, state: "disabled", note: "a single trade lost $0.0800" },
    });
    expect(off).toContain("Trading: ■ DISABLED  2026-10-05T11:00:00Z a single trade lost $0.0800");
    expect(off).toContain("npm run enable-trading");
    expect(off).toContain("Doing:   disabled: a single trade lost $0.0800");

    const micro = renderStatus({ ...base, live: { ...base.live!, mode: "micro" } });
    expect(micro).toContain("● RUNNING  (MICRO, tiny real trades via jito)");
    expect(micro).not.toContain("Test:");
    expect(micro).toContain("         Insufficient real execution sample: 0 MICRO trades landed (need 20)");

    const ready = renderStatus({ ...base, verdict: { micro: { ok: true, reasons: [] }, live: { ok: false, reasons: ["x"] } } });
    expect(ready).toContain("Go live? MICRO: YES  LIVE: NO");
  });

  it("shows pauses with their reason", () => {
    const text = renderStatus({ ...base, live: { ...base.live!, state: "paused", note: "daily loss limit reached" } });
    expect(text).toContain("Doing:   paused: daily loss limit reached");
  });

  it("formats bars and durations", () => {
    expect(bar(0.5, 10)).toBe("█████░░░░░");
    expect(bar(2, 4)).toBe("████");
    expect(duration(45_000)).toBe("45s");
    expect(duration(3 * 86_400_000 + 3600_000)).toBe("3d 1h");
  });
});
