import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Mode } from "./config.js";
import type { ExecStatus } from "./executor.js";

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
}

/** Append-only JSONL trade log. Plain file, no native deps. */
export class Ledger {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(rec: TradeRecord): void {
    appendFileSync(this.path, JSON.stringify(rec) + "\n");
  }

  all(): TradeRecord[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TradeRecord);
  }

  pnlBetween(fromTs: number, toTs = Number.POSITIVE_INFINITY, records = this.all()): number {
    return records.filter((r) => r.ts >= fromTs && r.ts < toTs).reduce((sum, r) => sum + r.netUsd, 0);
  }
}

export const startOfUtcDay = (ts: number): number => {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

export const startOfUtcMonth = (ts: number, offsetMonths = 0): number => {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offsetMonths, 1);
};
