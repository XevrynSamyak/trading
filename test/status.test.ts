import { describe, expect, it } from "vitest";
import { bar, duration, renderStatus, type StatusInput } from "../src/status.js";

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
  records: [],
  brainStartedAt: now - 1.5 * 86_400_000,
  edgeHistogram: { "-5..0": 8, "-20..-5": 2 },
  thoughts: ["I only trade when a gap pays at least 20bps (0.20%) after fees."],
  events: ["[2026-10-05T10:00:00Z] Started in PAPER mode"],
  monthlyCosts: { server: 0 },
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
    expect(text).toContain("Go live? KEEP-TESTING");
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

  it("shows which share of the tokens this phone watches", () => {
    const text = renderStatus({ ...base, live: { ...base.live!, shard: "2/2", watching: 4, totalTokens: 9 } });
    expect(text).toContain("Phone:   2 of 2, watching 4 of 9 tokens");
    expect(renderStatus(base)).not.toContain("Phone:");
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
