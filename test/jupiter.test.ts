import { describe, expect, it } from "vitest";
import { JupiterClient, type QuoteResponse } from "../src/jupiter.js";

function recorder() {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const body = url.includes("/quote")
      ? { inAmount: "1", outAmount: "1", otherAmountThreshold: "1", routePlan: [] }
      : { computeBudgetInstructions: [], setupInstructions: [], swapInstruction: {}, addressLookupTableAddresses: [] };
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  return { calls, fetchFn };
}

const q = { inputMint: "A", outputMint: "B", amount: 1n, slippageBps: 0 };

describe("Jupiter API key", () => {
  it("sends the key in the x-api-key header, never in the URL", async () => {
    const { calls, fetchFn } = recorder();
    const jup = new JupiterClient("https://api.jup.ag/swap/v1", fetchFn, "secret-key-123");
    await jup.quote(q);
    await jup.swapInstructions({} as QuoteResponse, "owner");
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.headers["x-api-key"]).toBe("secret-key-123");
      expect(c.url).not.toContain("secret-key-123");
    }
    expect(calls[1].headers["Content-Type"]).toBe("application/json");
  });

  it("sends no key header without a key", async () => {
    const { calls, fetchFn } = recorder();
    await new JupiterClient("https://lite-api.jup.ag/swap/v1", fetchFn).quote(q);
    expect(calls[0].headers).not.toHaveProperty("x-api-key");
  });
});
