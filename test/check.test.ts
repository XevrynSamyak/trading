import { describe, expect, it } from "vitest";
import { maskUrl } from "../src/check.js";

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
