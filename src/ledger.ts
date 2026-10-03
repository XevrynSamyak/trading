import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Mode } from "./config.js";

export interface TradeRecord {
  ts: number;
  mode: Mode;
  symbol: string;
  status: "filled" | "skipped" | "failed";
  inUsd: number;
  netUsd: number;
  feeUsd: number;
  signature?: string;
  reason?: string;
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
