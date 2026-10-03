import { describe, expect, it } from "vitest";
import type { TradeRecord } from "../src/ledger.js";
import { monthVerdict, shouldRetire } from "../src/sustain.js";

const t = (iso: string, netUsd: number): TradeRecord => ({
  ts: Date.parse(iso), mode: "paper", symbol: "SOL", status: "filled", inUsd: 10, netUsd, feeUsd: 0.002,
});

describe("sustainability", () => {
  const costs = { server: 0, rpc: 1 };

  it("says whether a month paid its own bills", () => {
    const recs = [t("2026-09-03T00:00:00Z", 0.7), t("2026-09-20T00:00:00Z", 0.5)];
    const v = monthVerdict(recs, Date.parse("2026-09-01T00:00:00Z"), costs);
    expect(v.paidItsWay).toBe(true);
    expect(v.surplusUsd).toBeCloseTo(0.2, 6);
  });

  it("retires after N losing months, but not before it has run that long", () => {
    const recs = [t("2026-08-02T00:00:00Z", 0.1), t("2026-09-02T00:00:00Z", 0.1)];
    const now = Date.parse("2026-10-01T00:00:00Z");
    expect(shouldRetire(recs, now, costs, 2, recs[0].ts)).toBe(true);
    expect(shouldRetire(recs, now, costs, 3, recs[0].ts)).toBe(false);
  });
});
