import { describe, expect, it } from "vitest";
import { limitsLine, maskUrl } from "../src/check.js";

describe("maskUrl", () => {
  it("hides the middle of an API key", () => {
    expect(maskUrl("https://mainnet.helius-rpc.com/?api-key=abcd1234-5678-efgh")).toBe(
      "https://mainnet.helius-rpc.com/?api-key=abcd…efgh",
    );
  });
  it("leaves URLs without a key alone", () => {
    expect(maskUrl("https://api.mainnet-beta.solana.com")).toBe("https://api.mainnet-beta.solana.com");
  });
});

describe("limits line", () => {
  it("lists every cap on losses and says there is no profit cap", () => {
    const base = { mode: "paper" as const, tradeSizePct: 0.8, maxTradeUsd: 0, microMaxTradeUsd: 5, lossFloorUsd: 17.5, dailyLossLimitUsd: 2 };
    expect(limitsLine(base)).toBe("per trade at most 80% of the USDC on hand; stops for good at $17.5, pauses for the day after -$2; no profit cap");
    expect(limitsLine({ ...base, mode: "micro", maxTradeUsd: 10 })).toMatch(/80% of the USDC on hand, \$10 \(MAX_TRADE_USD\), \$5 \(MICRO cap\)/);
  });
});
