import { describe, expect, it } from "vitest";
import { jupiterScanBudgetMs, loadConfig } from "../src/config.js";

describe("Jupiter settings", () => {
  it("without a key: keyless endpoint, 30 requests/min, about 3-4 scans/min", () => {
    const cfg = loadConfig({});
    expect(cfg.jupiterApi).toBe("https://lite-api.jup.ag/swap/v1");
    expect(cfg.jupiterTokensApi).toBe("https://lite-api.jup.ag/tokens/v2");
    expect(cfg.jupiterRpm).toBe(30);
    expect(cfg.minScanIntervalMs).toBe(16_364); // (60/T + 1) scans x 6 requests + 2 extras <= 30
  });

  it("with a free key: api.jup.ag, 60 requests/min, about 8-9 scans/min", () => {
    const cfg = loadConfig({ JUPITER_API_KEY: " my-key \n" });
    expect(cfg.jupiterApiKey).toBe("my-key");
    expect(cfg.jupiterApi).toBe("https://api.jup.ag/swap/v1");
    expect(cfg.jupiterTokensApi).toBe("https://api.jup.ag/tokens/v2");
    expect(cfg.jupiterRpm).toBe(60);
    expect(cfg.minScanIntervalMs).toBe(6_924);
  });

  it("moves an old .env's lite-api address to api.jup.ag when a key is added (lite-api ignores keys)", () => {
    const cfg = loadConfig({ JUPITER_API: "https://lite-api.jup.ag/swap/v1/", JUPITER_API_KEY: "k" });
    expect(cfg.jupiterApi).toBe("https://api.jup.ag/swap/v1");
  });

  it("keeps a custom address as is", () => {
    expect(loadConfig({ JUPITER_API: "http://127.0.0.1:9/swap/v1", JUPITER_API_KEY: "k" }).jupiterApi).toBe(
      "http://127.0.0.1:9/swap/v1",
    );
  });

  it("stays under the limit in every 60-second window", () => {
    for (const rpm of [30, 60, 600]) {
      const t = jupiterScanBudgetMs(rpm);
      const worstWindow = (Math.floor(60_000 / t) + 1) * 6 + 2;
      expect(worstWindow).toBeLessThanOrEqual(rpm);
    }
    expect(jupiterScanBudgetMs(7)).toBe(60_000); // a tiny limit can't fit a scan: slowest pace
  });

  it("never lets MIN_SCAN_INTERVAL_MS go faster than the request budget", () => {
    expect(loadConfig({ MIN_SCAN_INTERVAL_MS: "2000" }).minScanIntervalMs).toBe(16_364);
    expect(loadConfig({ MIN_SCAN_INTERVAL_MS: "20000" }).minScanIntervalMs).toBe(20_000);
    // A paid plan's budget (0.61s) is faster than the 1s absolute floor, so the floor wins.
    expect(jupiterScanBudgetMs(600)).toBe(609);
    expect(loadConfig({ JUPITER_API_KEY: "k", JUPITER_RPM: "600" }).minScanIntervalMs).toBe(1_000);
  });
});
