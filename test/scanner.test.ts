import { describe, expect, it } from "vitest";
import type { CostSettings } from "../src/costs.js";
import { twoLegSpec } from "../src/cycle.js";
import { JupiterClient } from "../src/jupiter.js";
import { scanCycles } from "../src/scanner.js";

/** Old fixed-fee setup: 5000 base + 10000 priority lamports, no tip, no buffer. */
const FEES: CostSettings = {
  priorityFeeLamports: 10_000, sendVia: "rpc", tipShare: 0, minTipLamports: 0, maxTipLamports: 0,
  safetyBufferBps: 0, safetyBufferUsd: 0,
};
const specs = (...syms: string[]) => syms.map((s) => twoLegSpec(s, s));

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
    const opps = await scanCycles(jup, specs("Y", "X"), () => 10_000_000n, 200, FEES);
    expect(opps.map((o) => o.cycle.symbol)).toEqual(["X", "Y"]);
    expect(opps[0].val.netUsd).toBeCloseTo(0.1 - 0.003, 6);
    expect(opps[1].val.netUsd).toBeLessThan(0);
    expect(opps[0].cycle.legs).toHaveLength(2);
    expect(opps[0].cycle.routes).toBe("Fake | Fake");
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
    const opps = await scanCycles(new JupiterClient("https://fake", fetchFn), specs("X", "Y", "BAD"), () => 10_000_000n, 200, FEES, { onError: (s, e) => errors.push(`${s.symbol}: ${String(e)}`) });
    expect(opps.map((o) => o.cycle.symbol)).toEqual(["X", "Y"]);
    expect(errors[0]).toMatch(/^BAD: .*429/);
    expect(maxInFlight).toBe(3);
  });

  it("with a pacing hook, quotes one token at a time and waits before each", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const base = fakeFetch();
    const fetchFn = (async (url: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      order.push(new URL(url).searchParams.get("inputMint")!.startsWith("EPjF") ? "buy" : "sell");
      return base(url);
    }) as typeof fetch;
    let waits = 0;
    const opps = await scanCycles(new JupiterClient("https://fake", fetchFn), specs("X", "Y"), () => 10_000_000n, 200, FEES, {
      beforeEach: async () => {
        waits++;
      },
    });
    expect(opps.map((o) => o.cycle.symbol)).toEqual(["X", "Y"]);
    expect(waits).toBe(2);
    expect(maxInFlight).toBe(1);
    expect(order).toEqual(["buy", "sell", "buy", "sell"]); // each token's two legs stay together
  });

  it("a failing pacing hook (bot stopping) skips the token instead of crashing", async () => {
    const errors: string[] = [];
    const opps = await scanCycles(new JupiterClient("https://fake", fakeFetch()), specs("X"), () => 10_000_000n, 200, FEES, {
      onError: (s) => errors.push(s.symbol),
      beforeEach: async () => {
        throw new Error("stopping");
      },
    });
    expect(opps).toEqual([]);
    expect(errors).toEqual(["X"]);
  });

  it("stops at the first candidate so it is acted on while the quote is fresh", async () => {
    const quoted: string[] = [];
    const base = fakeFetch();
    const fetchFn = (async (url: string) => {
      const u = new URL(url);
      if (u.searchParams.get("inputMint")!.startsWith("EPjF")) quoted.push(u.searchParams.get("outputMint")!);
      return base(url);
    }) as typeof fetch;
    const opps = await scanCycles(new JupiterClient("https://fake", fetchFn), specs("Y", "X", "Z"), () => 10_000_000n, 200, FEES, {
      beforeEach: async () => {},
      stopAfter: (s) => s.val.netUsd > 0,
    });
    expect(opps.map((o) => o.cycle.symbol)).toEqual(["X", "Y"]);
    expect(quoted).toEqual(["Y", "X"]); // Z was never quoted
  });
});
