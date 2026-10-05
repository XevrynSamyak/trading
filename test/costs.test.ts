import { describe, expect, it } from "vitest";
import { estimateCosts, valueCycle, type CostSettings } from "../src/costs.js";
import { legFeeBps } from "../src/cycle.js";
import { planFloor, revalue } from "../src/executor.js";
import type { QuoteResponse } from "../src/jupiter.js";

const SOL = 100; // $ per SOL: 1 lamport = $1e-7
const BASE: CostSettings = {
  priorityFeeLamports: 1_000, sendVia: "jito", tipShare: 0.25, minTipLamports: 1_000, maxTipLamports: 2_000_000,
  safetyBufferBps: 3, safetyBufferUsd: 0.001,
};
const usdc = (usd: number) => BigInt(Math.round(usd * 1e6));
const val = (inUsd: number, outUsd: number, s = BASE) => valueCycle({ inAtoms: usdc(inUsd), outAtoms: usdc(outUsd) }, SOL, s);

describe("profitability model", () => {
  it("a real gap is profitable after every cost", () => {
    const v = val(100, 101); // +1% gross
    expect(v.grossUsd).toBeCloseTo(1, 9);
    expect(v.netUsd).toBeGreaterThan(0.5);
    expect(v.netUsd).toBeCloseTo(v.grossUsd - v.costs.totalUsd, 12);
  });

  it("a negative round trip is unprofitable", () => {
    expect(val(100, 99.9).netUsd).toBeLessThan(0);
  });

  it("fees eliminate a tiny gross edge", () => {
    // +0.5bps on $10 = $0.0005 gross; base + priority + buffer alone exceed it.
    const v = val(10, 10.0005);
    expect(v.grossUsd).toBeGreaterThan(0);
    expect(v.netUsd).toBeLessThan(0);
  });

  it("slippage eliminates profit: the same trade re-quoted lower falls below the floor", () => {
    const quoted = { inAtoms: usdc(10), outAtoms: usdc(10.05) };
    const v = valueCycle(quoted, SOL, BASE);
    const plan = planFloor(quoted, v.costs, 20, 100)!;
    const slipped = { inAtoms: usdc(10), outAtoms: usdc(10.01) }; // the market moved 40bps against us
    expect(slipped.outAtoms).toBeLessThan(plan.required);
    expect(revalue(slipped, v.costs).netUsd).toBeLessThan(v.netUsd);
  });

  it("the Jito tip can eliminate profit when the minimum tip is high", () => {
    const expensive = { ...BASE, minTipLamports: 1_000_000 }; // $0.10 minimum tip
    expect(val(10, 10.05).netUsd).toBeGreaterThan(0);
    expect(val(10, 10.05, expensive).netUsd).toBeLessThan(0);
  });

  it("the tip scales with expected profit but never above its share or the cap", () => {
    const small = estimateCosts(0.1, 10, SOL, BASE);
    const big = estimateCosts(10, 1000, SOL, BASE);
    expect(big.tipLamports).toBeGreaterThan(small.tipLamports);
    const room = 0.1 - small.networkUsd + small.tipUsd - small.bufferUsd;
    expect(small.tipUsd).toBeLessThanOrEqual(room * 0.25 + 1e-9);
    expect(estimateCosts(1_000, 100_000, SOL, BASE).tipLamports).toBe(2_000_000);
  });

  it("no tip at all when sending through plain RPC", () => {
    expect(estimateCosts(1, 100, SOL, { ...BASE, sendVia: "rpc" }).tipLamports).toBe(0);
  });

  it("the safety buffer grows with trade size", () => {
    expect(estimateCosts(1, 1000, SOL, BASE).bufferUsd).toBeCloseTo(0.3 + 0.001, 9);
  });
});

describe("DEX fees inside quotes", () => {
  it("reads the fee each hop reports, weighted by split percent", () => {
    const q = {
      routePlan: [
        { percent: 100, swapInfo: { inputMint: "A", outputMint: "B", inAmount: "1000000", outAmount: "990000", feeAmount: "2500", feeMint: "A" } },
        { percent: 100, swapInfo: { inputMint: "B", outputMint: "C", inAmount: "990000", outAmount: "980000", feeAmount: "0", feeMint: "B" } },
      ],
    } as unknown as QuoteResponse;
    expect(legFeeBps(q)).toBeCloseTo(25, 6);
  });
});
