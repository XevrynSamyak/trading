import { describe, expect, it } from "vitest";
import { RiskManager } from "../src/risk.js";
import { loadConfig, tradeSizeUsd } from "../src/config.js";

const limits = {
  lossFloorUsd: 17.5, dailyLossLimitUsd: 2, maxConsecutiveFailures: 3, failureCooldownMs: 60_000,
  maxConsecutiveLosses: 3, unexpectedLossUsd: 0.05,
};

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

describe("stronger risk controls", () => {
  it("pauses after consecutive losing trades, and a win resets the count", () => {
    const r = new RiskManager(limits);
    r.recordResult("filled", 0, -0.01);
    r.recordResult("filled", 0, -0.01);
    r.recordResult("filled", 0, 0.02); // win resets
    r.recordResult("filled", 0, -0.01);
    r.recordResult("filled", 0, -0.01);
    expect(r.check(25, 0, 1).ok).toBe(true);
    r.recordResult("failed", 0, -0.002);
    const d = r.check(25, 0, 1);
    expect(d).toMatchObject({ ok: false, halt: false });
    expect((d as { reason: string }).reason).toMatch(/3 losing trades in a row/);
  });

  it("flags unexpected outcomes for the kill switch", () => {
    const r = new RiskManager(limits);
    expect(r.unexpected("timeout", 0)).toMatch(/could not be confirmed/);
    expect(r.unexpected("filled", -0.2)).toMatch(/lost \$0.2000/);
    expect(r.unexpected("failed", -0.002)).toBeNull(); // a failed tx paying its fee is normal
    expect(r.unexpected("stale", 0)).toBeNull();
  });
});

describe("kill switch", () => {
  it("disables trading until a person re-enables it", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { disableTrading, enableTrading, tradingDisabled } = await import("../src/killswitch.js");
    const dir = mkdtempSync(join(tmpdir(), "kill-"));
    expect(tradingDisabled(dir).disabled).toBe(false);
    disableTrading(dir, "test reason");
    expect(tradingDisabled(dir)).toMatchObject({ disabled: true });
    expect(tradingDisabled(dir).reason).toMatch(/test reason/);
    expect(enableTrading(dir)).toBe(true);
    expect(tradingDisabled(dir).disabled).toBe(false);
    expect(enableTrading(dir)).toBe(false);
  });
});

describe("exposure and size caps", () => {
  it("MAX_EXPOSURE_PCT caps each trade's share of the wallet; MAX_TRADE_USD caps the amount", () => {
    const cfg = loadConfig({ MAX_EXPOSURE_PCT: "0.5", MAX_TRADE_USD: "8" });
    expect(tradeSizeUsd(cfg, 10)).toBe(5);
    expect(tradeSizeUsd(cfg, 100)).toBe(8);
  });
});

