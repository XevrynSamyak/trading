import { describe, expect, it } from "vitest";
import { RiskManager } from "../src/risk.js";
import { loadConfig, tradeSizeUsd } from "../src/config.js";

const limits = { lossFloorUsd: 17.5, dailyLossLimitUsd: 2, maxConsecutiveFailures: 3, failureCooldownMs: 60_000 };

describe("RiskManager", () => {
  it("halts at the loss floor", () => {
    const d = new RiskManager(limits).check(17.4, 0);
    expect(d).toMatchObject({ ok: false, halt: true });
  });

  it("pauses (not halts) on the daily loss limit", () => {
    expect(new RiskManager(limits).check(24, -2.1)).toMatchObject({ ok: false, halt: false });
  });

  it("never blocks on profit", () => {
    expect(new RiskManager(limits).check(1_000_000, 50_000)).toEqual({ ok: true });
  });

  it("cools down after repeated failures, then resumes", () => {
    const r = new RiskManager(limits);
    for (let i = 0; i < 3; i++) r.recordResult("failed", 0);
    expect(r.check(25, 0, 1_000).ok).toBe(false);
    expect(r.check(25, 0, 61_000).ok).toBe(true);
  });
});

describe("config", () => {
  it("defaults to paper mode and refuses live without explicit confirmation", () => {
    expect(loadConfig({}).mode).toBe("paper");
    expect(() => loadConfig({ MODE: "live", WALLET_SECRET_KEY: "x" })).toThrow(/LIVE_TRADING_CONFIRM/);
  });

  it("compounds trade size with the balance and has no cap by default", () => {
    const cfg = loadConfig({});
    expect(tradeSizeUsd(cfg, 25)).toBe(20);
    expect(tradeSizeUsd(cfg, 1000)).toBe(800);
    expect(tradeSizeUsd({ ...cfg, maxTradeUsd: 50 }, 1000)).toBe(50);
  });
});
