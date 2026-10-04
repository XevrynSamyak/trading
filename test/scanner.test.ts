import { describe, expect, it } from "vitest";
import { JupiterClient } from "../src/jupiter.js";
import { scan } from "../src/scanner.js";

/** Fake Jupiter: token X has a 1% gap, token Y loses 0.3%. */
function fakeFetch(): typeof fetch {
  return (async (url: string) => {
    const u = new URL(url);
    const amount = BigInt(u.searchParams.get("amount")!);
    const out = u.searchParams.get("inputMint")!.startsWith("EPjF")
      ? amount * 2n // USDC -> token
      : u.searchParams.get("inputMint") === "X" ? (amount * 101n) / 200n : (amount * 997n) / 2000n;
    const body = {
      inputMint: u.searchParams.get("inputMint"), outputMint: u.searchParams.get("outputMint"),
      inAmount: amount.toString(), outAmount: out.toString(), otherAmountThreshold: out.toString(),
      slippageBps: 0, priceImpactPct: "0", routePlan: [{ swapInfo: { label: "Fake" } }],
    };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

describe("scan", () => {
  it("ranks round trips by net profit after fees", async () => {
    const jup = new JupiterClient("https://fake", fakeFetch());
    const opps = await scan(jup, { Y: "Y", X: "X" }, () => 10_000_000n, 10_000, 200);
    expect(opps.map((o) => o.symbol)).toEqual(["X", "Y"]);
    expect(opps[0].eval.netUsd).toBeCloseTo(0.1 - 0.003, 6);
    expect(opps[1].eval.netUsd).toBeLessThan(0);
  });
});

describe("parallel scan", () => {
  it("quotes all tokens at once and keeps the ones that succeed", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const base = fakeFetch();
    const fetchFn = (async (url: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      if (url.includes("outputMint=BAD")) return new Response("Too Many Requests", { status: 429 });
      return base(url);
    }) as typeof fetch;
    const errors: string[] = [];
    const opps = await scan(new JupiterClient("https://fake", fetchFn), { X: "X", Y: "Y", BAD: "BAD" }, () => 10_000_000n, 10_000, 200, (s, e) => errors.push(`${s}: ${String(e)}`));
    expect(opps.map((o) => o.symbol)).toEqual(["X", "Y"]);
    expect(errors[0]).toMatch(/^BAD: .*429/);
    expect(maxInFlight).toBe(3);
  });
});
