import { describe, expect, it } from "vitest";
import { evaluateRoundTrip, requiredOutAtoms, slippageForFloor, usdToUsdcAtoms } from "../src/profit.js";

describe("profit math", () => {
  it("subtracts network fees from the gross gap", () => {
    // $10 in, $10.05 out, 15k lamports total fee at SOL=$200 -> $0.003 fee
    const e = evaluateRoundTrip(usdToUsdcAtoms(10), usdToUsdcAtoms(10.05), 10_000, 200);
    expect(e.grossUsd).toBeCloseTo(0.05, 6);
    expect(e.feeUsd).toBeCloseTo(0.003, 6);
    expect(e.netUsd).toBeCloseTo(0.047, 6);
    expect(e.netBps).toBeCloseTo(47, 3);
  });

  it("reports a loss when the round trip comes back short", () => {
    const e = evaluateRoundTrip(usdToUsdcAtoms(10), usdToUsdcAtoms(9.99), 10_000, 200);
    expect(e.netUsd).toBeLessThan(0);
  });

  it("sets leg 2's on-chain floor at input + fees + min profit", () => {
    const required = requiredOutAtoms(usdToUsdcAtoms(10), 0.003, 20); // 20bps of $10 = $0.02
    expect(required).toBe(usdToUsdcAtoms(10.023));
  });

  it("computes the slippage that hits that floor exactly", () => {
    const quoted = usdToUsdcAtoms(10.05);
    const required = usdToUsdcAtoms(10.023);
    const slip = slippageForFloor(quoted, required)!;
    const floor = (quoted * BigInt(10_000 - slip)) / 10_000n;
    expect(floor >= required).toBe(true);
    expect(slippageForFloor(usdToUsdcAtoms(10), required)).toBeNull();
  });
});
