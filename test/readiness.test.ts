import { describe, expect, it } from "vitest";
import type { TradeRecord } from "../src/ledger.js";
import { assessReadiness } from "../src/readiness.js";

const DAY = 86_400_000;
const now = Date.parse("2026-10-10T00:00:00Z");
const costs = { server: 0, rpc: 0 };
const rec = (status: TradeRecord["status"], netUsd: number, verified: boolean): TradeRecord => ({
  ts: now - DAY, mode: "paper", symbol: "SOL", status, inUsd: 10, netUsd, feeUsd: 0.001, verified,
});

describe("go-live verdict", () => {
  it("asks for more time first", () => {
    expect(assessReadiness([], now - DAY, now, costs).verdict).toBe("keep-testing");
  });

  it("says no when no gaps showed up", () => {
    expect(assessReadiness([], now - 3 * DAY, now, costs).verdict).toBe("no-gaps");
  });

  it("refuses to trust quote-only wins", () => {
    const r = assessReadiness([rec("filled", 0.05, false)], now - 3 * DAY, now, costs);
    expect(r.verdict).toBe("verify-first");
  });

  it("says no when every gap was fake on-chain", () => {
    const r = assessReadiness([rec("rejected", 0, true), rec("filled", 0.05, false)], now - 3 * DAY, now, costs);
    expect(r.verdict).toBe("all-fake");
  });

  it("recommends a careful live test only with verified profit above the bills", () => {
    const recs = [rec("filled", 0.3, true), rec("rejected", 0, true)];
    const r = assessReadiness(recs, now - 3 * DAY, now, costs);
    expect(r.verdict).toBe("try-live");
    expect(r.projectedMonthlyUsd).toBeCloseTo(3, 6);
    expect(assessReadiness(recs, now - 3 * DAY, now, { server: 5 }).verdict).toBe("not-worth-it");
  });
});
