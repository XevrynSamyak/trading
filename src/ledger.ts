import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Mode } from "./config.js";
import type { ExecStatus } from "./executor.js";

/**
 * What an amount is based on. Only "simulated" and "realized" are evidence;
 * "quoted" is what a price quote promised and is NEVER profit.
 *  - quoted:    from Jupiter quotes only (paper mode without on-chain testing)
 *  - simulated: the exact transaction simulated on the real chain (paper, nothing sent)
 *  - realized:  a real transaction landed and the wallet balance changed (micro/live)
 */
export type Basis = "quoted" | "simulated" | "realized";

export interface TradeRecord {
  ts: number;
  mode: Mode;
  symbol: string;
  status: ExecStatus;
  inUsd: number;
  netUsd: number;
  feeUsd: number;
  signature?: string;
  reason?: string;
  /** True if checked against the real chain (on-chain simulation or a live trade). */
  verified?: boolean;
  basis?: Basis;
  /** Links to the opportunity funnel record (opps-<mode>.jsonl). */
  opportunityId?: string;
}

/** The basis of a record; older records without the field are inferred. */
export function basisOf(r: TradeRecord): Basis {
  if (r.basis) return r.basis;
  if (r.mode === "live" || r.mode === "micro") return "realized";
  return r.verified ? "simulated" : "quoted";
}

/** Which basis counts as money in each mode (quoted never does). */
export function moneyBasis(mode: Mode): Basis {
  return mode === "paper" ? "simulated" : "realized";
}

/**
 * Append-only JSONL trade log. Read once, then kept in memory so the main
 * loop does not re-read a growing file every cycle.
 */
export class Ledger {
  private cache: TradeRecord[] | null = null;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(rec: TradeRecord): void {
    appendFileSync(this.path, JSON.stringify(rec) + "\n");
    this.cache?.push(rec);
  }

  all(): TradeRecord[] {
    if (!this.cache) this.cache = Ledger.read(this.path);
    return this.cache;
  }

  static read(path: string): TradeRecord[] {
    if (!existsSync(path)) return [];
    const out: TradeRecord[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as TradeRecord);
      } catch {
        // a torn last line after a crash: skip it rather than refuse to start
      }
    }
    return out;
  }

  /** Net P&L in [fromTs, toTs), optionally only for the given bases. */
  pnlBetween(fromTs: number, toTs = Number.POSITIVE_INFINITY, records = this.all(), bases?: Basis[]): number {
    return records
      .filter((r) => r.ts >= fromTs && r.ts < toTs && (!bases || bases.includes(basisOf(r))))
      .reduce((sum, r) => sum + r.netUsd, 0);
  }
}

export interface BasisTotals {
  count: number;
  wins: number;
  netUsd: number;
}

/** Totals per basis, for screens that must never mix quoted with real numbers. */
export function totalsByBasis(records: TradeRecord[], sinceTs = 0): Record<Basis, BasisTotals> {
  const empty = (): BasisTotals => ({ count: 0, wins: 0, netUsd: 0 });
  const out: Record<Basis, BasisTotals> = { quoted: empty(), simulated: empty(), realized: empty() };
  for (const r of records) {
    if (r.ts < sinceTs || r.status === "skipped") continue;
    const t = out[basisOf(r)];
    t.count += 1;
    if (r.status === "filled") t.wins += r.netUsd > 0 ? 1 : 0;
    t.netUsd += r.netUsd;
  }
  return out;
}

export const startOfUtcDay = (ts: number): number => {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

export const startOfUtcMonth = (ts: number, offsetMonths = 0): number => {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offsetMonths, 1);
};
