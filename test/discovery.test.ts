import { describe, expect, it } from "vitest";
import { USDC_MINT } from "../src/config.js";
import { discoverTokens, parseTokenFacts, parseTopTokens } from "../src/discovery.js";

const opts = { minLiquidityUsd: 1_000_000, limit: 10 };

describe("token discovery", () => {
  it("keeps only verified, liquid, non-stable tokens", () => {
    const found = parseTopTokens(
      [
        { id: "good-mint", symbol: "GOOD", liquidity: 5_000_000, isVerified: true },
        { id: "thin-mint", symbol: "THIN", liquidity: 10_000, isVerified: true },
        { id: "scam-mint", symbol: "SCAM", liquidity: 9_000_000, isVerified: false },
        { id: USDC_MINT, symbol: "USDC", liquidity: 1e9, isVerified: true },
        { id: "tag-mint", symbol: "$Tag!", liquidity: 2_000_000, tags: ["verified"] },
        { id: "dupe-mint", symbol: "GOOD", liquidity: 3_000_000, isVerified: true },
      ],
      opts,
    );
    expect(found).toEqual({ GOOD: "good-mint", TAG: "tag-mint", "GOOD-dupe": "dupe-mint" });
  });

  it("keeps the market facts the safety check needs, leaving unknown ones unset", () => {
    const facts = parseTokenFacts([
      {
        id: "m1", symbol: "A", liquidity: 2_000_000, holderCount: 5400, isVerified: true,
        firstPool: { createdAt: "2026-09-01T00:00:00Z" }, audit: { topHoldersPercentage: 23.5 },
      },
      { id: "m2", symbol: "B" },
    ]);
    expect(facts.m1).toEqual({ liquidityUsd: 2_000_000, holders: 5400, poolCreatedAt: Date.parse("2026-09-01T00:00:00Z"), topHoldersPct: 23.5, verified: true });
    expect(facts.m2).toEqual({ liquidityUsd: undefined, holders: undefined, poolCreatedAt: undefined, topHoldersPct: undefined, verified: false });
  });

  it("returns nothing for an unexpected response", () => {
    expect(parseTopTokens({ error: "nope" }, opts)).toEqual({});
  });

  it("throws on HTTP errors so the bot keeps its current list", async () => {
    const fetchFn = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
    await expect(discoverTokens("https://fake", opts, fetchFn)).rejects.toThrow(/429/);
  });
});

describe("token discovery with an API key", () => {
  it("sends the key header", async () => {
    let headers: Record<string, string> = {};
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return new Response("[]");
    }) as typeof fetch;
    await discoverTokens("https://api.jup.ag/tokens/v2", opts, fetchFn, "k123");
    expect(headers["x-api-key"]).toBe("k123");
  });
});
