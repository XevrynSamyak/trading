import type { TradeRecord } from "./ledger.js";
import { startOfUtcMonth } from "./ledger.js";

/**
 * "Does the bot pay its own bills?" The bills themselves are charged by the
 * providers to a prepaid card the owner set up; this only checks whether
 * trading profit covered them.
 */
export interface MonthVerdict {
  month: string; // YYYY-MM
  tradingPnlUsd: number;
  costsUsd: number;
  surplusUsd: number;
  paidItsWay: boolean;
}

export function monthVerdict(records: TradeRecord[], monthStart: number, monthlyCosts: Record<string, number>): MonthVerdict {
  const end = startOfUtcMonth(monthStart, 1);
  const tradingPnlUsd = records.filter((r) => r.ts >= monthStart && r.ts < end).reduce((s, r) => s + r.netUsd, 0);
  const costsUsd = Object.values(monthlyCosts).reduce((s, v) => s + v, 0);
  const surplusUsd = tradingPnlUsd - costsUsd;
  return {
    month: new Date(monthStart).toISOString().slice(0, 7),
    tradingPnlUsd,
    costsUsd,
    surplusUsd,
    paidItsWay: surplusUsd >= 0,
  };
}

/** True if each of the last `months` completed months failed to cover costs. */
export function shouldRetire(
  records: TradeRecord[],
  now: number,
  monthlyCosts: Record<string, number>,
  months: number,
  firstTradeTs: number | undefined,
): boolean {
  if (months <= 0 || firstTradeTs === undefined) return false;
  for (let i = 1; i <= months; i++) {
    const start = startOfUtcMonth(now, -i);
    if (start < startOfUtcMonth(firstTradeTs)) return false; // not running long enough to judge
    if (monthVerdict(records, start, monthlyCosts).paidItsWay) return false;
  }
  return true;
}

export function formatVerdict(v: MonthVerdict): string {
  const sign = (n: number) => (n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`);
  return (
    `${v.month}: trading ${sign(v.tradingPnlUsd)}, bills $${v.costsUsd.toFixed(2)} -> ` +
    (v.paidItsWay ? `paid its own way (${sign(v.surplusUsd)} left over)` : `short by $${Math.abs(v.surplusUsd).toFixed(2)}`)
  );
}
