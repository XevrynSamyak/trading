import { describe, expect, it } from "vitest";
import { jupiterMsPerRequest, jupiterRateWindows, loadConfig, maxScansPerMin } from "../src/config.js";

describe("Jupiter settings", () => {
  it("without a key: keyless endpoint, 30 requests/min, 4 full scans/min", () => {
    const cfg = loadConfig({});
    expect(cfg.jupiterApi).toBe("https://lite-api.jup.ag/swap/v1");
    expect(cfg.jupiterTokensApi).toBe("https://lite-api.jup.ag/tokens/v2");
    expect(cfg.jupiterRpm).toBe(30);
    expect(cfg.jupiterMsPerRequest).toBe(2_500); // at most 4 requests per 10s
    expect(maxScansPerMin(cfg.jupiterMsPerRequest)).toBeCloseTo(4, 2);
  });

  it("with a free key: api.jup.ag, 60 requests/min, ~9 full scans or ~27 focus scans/min", () => {
    const cfg = loadConfig({ JUPITER_API_KEY: " my-key \n" });
    expect(cfg.jupiterApiKey).toBe("my-key");
    expect(cfg.jupiterApi).toBe("https://api.jup.ag/swap/v1");
    expect(cfg.jupiterTokensApi).toBe("https://api.jup.ag/tokens/v2");
    expect(cfg.jupiterRpm).toBe(60);
    expect(cfg.jupiterMsPerRequest).toBe(1_112); // at most 9 requests per 10s
    expect(maxScansPerMin(cfg.jupiterMsPerRequest)).toBeCloseTo(8.99, 2);
    expect(maxScansPerMin(cfg.jupiterMsPerRequest, 2)).toBeCloseTo(26.98, 2);
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

  it("supports paid plans and an absolute speed floor", () => {
    expect(jupiterMsPerRequest(600)).toBe(102);
    expect(jupiterMsPerRequest(2)).toBe(60_000); // nothing usable: slowest pace
    expect(loadConfig({}).minScanIntervalMs).toBe(1_000);
    expect(loadConfig({ MIN_SCAN_INTERVAL_MS: "3000" }).minScanIntervalMs).toBe(3_000);
  });

  it("limits both the minute and any 10 seconds", () => {
    expect(jupiterRateWindows(60)).toEqual([
      { ms: 60_000, limit: 58 },
      { ms: 10_000, limit: 9 },
    ]);
    expect(jupiterRateWindows(30)).toEqual([
      { ms: 60_000, limit: 28 },
      { ms: 10_000, limit: 4 },
    ]);
  });
});
