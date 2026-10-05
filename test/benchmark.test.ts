import { describe, expect, it } from "vitest";
import { explain, runBenchmark, summarize, type BenchDeps } from "../src/benchmark.js";
import type { QuoteResponse } from "../src/jupiter.js";

describe("benchmark statistics", () => {
  it("reports median, p90, min and max", () => {
    expect(summarize([300, 100, 200, 400], 1)).toEqual({ n: 4, errors: 1, medianMs: 250, p90Ms: 400, minMs: 100, maxMs: 400 });
    expect(summarize([5])).toMatchObject({ medianMs: 5, p90Ms: 5 });
    expect(summarize([], 3)).toEqual({ n: 0, errors: 3, medianMs: null, p90Ms: null, minMs: null, maxMs: null });
  });
});

/** Fake services on a fake clock: every call "takes" a fixed time. */
function fakeDeps(o: { quoteMs: number; rpcMs: number; failRpc?: boolean; withQuotes?: boolean }) {
  let t = 0;
  const calls: string[] = [];
  const take = async (ms: number) => {
    t += ms;
  };
  const q = (out: string): QuoteResponse =>
    ({ outAmount: out, routePlan: [{ swapInfo: { ammKey: "Pool1111111111111111111111111111111111111111", label: "X" } }] }) as unknown as QuoteResponse;
  const deps: BenchDeps = {
    now: () => t,
    sleep: async (ms) => {
      calls.push(`sleep ${ms}`);
      t += ms;
    },
    rpcSlot: async () => {
      await take(o.rpcMs);
      if (o.failRpc) throw new Error("401");
    },
    rpcBlockhash: () => take(o.rpcMs * 2),
    quote: o.withQuotes === false ? undefined : async (inMint) => {
      calls.push(`quote ${inMint.slice(0, 4)}`);
      await take(o.quoteMs);
      return q("166000000");
    },
    watchAccount: async (account, ms) => {
      calls.push(`watch ${account.slice(0, 5)}`);
      t += ms;
      return { events: 50, firstMs: 300 };
    },
    watchSlots: async (ms) => {
      t += ms;
      return { events: 12, firstMs: 400 };
    },
  };
  return { deps, calls };
}

const OPTS = { rpcSamples: 4, quoteSamples: 4, jupiterGapMs: 2_000, watchMs: 20_000, amountAtoms: 20_000_000n };

describe("benchmark run", () => {
  it("times each service, paces Jupiter requests, and watches the quoted pool", async () => {
    const { deps, calls } = fakeDeps({ quoteMs: 250, rpcMs: 40 });
    const lines: string[] = [];
    const r = await runBenchmark(deps, OPTS, (l) => lines.push(l));
    expect(r.rpcSlot.medianMs).toBe(40);
    expect(r.rpcBlockhash.medianMs).toBe(80);
    expect(r.quoteLeg?.medianMs).toBe(250);
    expect(r.quoteRoundTrip?.medianMs).toBe(500); // two legs back to back, pacing not counted
    expect(r.minGapLifetimeMs).toBe(1_000);
    expect(r.pool).toMatchObject({ events: 50, perMin: 150, firstMs: 300 });
    expect(r.slotsPerSec).toBeCloseTo(2.4);
    // Never two Jupiter requests without a pause, except a round trip's two legs.
    const firstQuote = calls.indexOf("quote EPjF");
    expect(calls.slice(firstQuote, firstQuote + 3)).toEqual(["quote EPjF", "sleep 2000", "quote EPjF"]);
    expect(calls).toContain("watch Pool1");
    expect(lines.find((l) => l.startsWith("Jupiter round trip"))).toMatch(/median 500 ms/);
  });

  it("reports failures instead of crashing, and skips Jupiter while the bot runs", async () => {
    const { deps } = fakeDeps({ quoteMs: 250, rpcMs: 40, failRpc: true, withQuotes: false });
    const lines: string[] = [];
    const r = await runBenchmark(deps, OPTS, (l) => lines.push(l));
    expect(r.rpcSlot).toMatchObject({ n: 0, errors: 4, medianMs: null });
    expect(lines[0]).toMatch(/RPC getSlot\s+FAILED/);
    expect(r.quoteLeg).toBeUndefined();
    expect(r.minGapLifetimeMs).toBeNull();
    expect(r.pool).toBeUndefined(); // no quote, so no pool to watch
    expect(lines.join("\n")).toMatch(/Jupiter\s+skipped: the bot is running/);
  });

  it("explains what the numbers mean", () => {
    const text = explain({
      ts: 0,
      rpcSlot: summarize([40]),
      rpcBlockhash: summarize([80]),
      quoteRoundTrip: summarize([500]),
      minGapLifetimeMs: 1_000,
      pool: { account: "p", seconds: 20, events: 50, perMin: 150, firstMs: 300 },
    }).join("\n");
    expect(text).toMatch(/at least ~1000 ms/);
    expect(text).toMatch(/too busy to be a useful trigger/);
  });
});
