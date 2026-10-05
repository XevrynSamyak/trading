import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "./atomic.js";
import type { Mode } from "./config.js";

/** Snapshot the bot writes after every cycle so `npm run status` can show live progress. */
export interface LiveStatus {
  pid: number;
  mode: Mode;
  startedAt: number;
  updatedAt: number;
  cycles: number;
  /** "disabled": the kill switch (data/TRADING_DISABLED) is on; the bot waits. */
  state: "scanning" | "paused" | "waiting" | "disabled" | "stopped";
  note?: string;
  onChainTesting: boolean;
  sendVia: string;
  solPrice: number;
  walletValueUsd: number;
  tradeSizeUsd: number;
  lastBest?: { symbol: string; netBps: number; expectedBps: number; needBps: number };
  hot: string[];
  nextScanInMs: number;
  /** Fastest safe pace the brain has learned for a full scan (ms). */
  paceFloorMs?: number;
  /** Tokens getting focus scans right now (moving fast or nearly a gap). */
  focus?: string[];
  /** Jupiter requests sent in the last 60s, and the per-minute limit. */
  jupiterUsed?: number;
  jupiterLimit?: number;
  scansLastMin?: number;
  /** Opportunities acted on today, by the furthest funnel stage reached. */
  funnelToday?: Record<string, number>;
  /** Typical time to quote all legs of one cycle, measured by the bot (ms). */
  quoteMs?: number;
  /** Pool event triggers: pools watched, updates today and the daily cap. */
  events?: { watching: number; eventsToday: number; capped: boolean; tooBusy: number; cap: number };
  /** The most recent opportunity the bot acted on. */
  lastOpp?: { id: string; symbol: string; stage: string; result: string; totalMs: number; quotedBps: number; execBps?: number };
}

export function writeStatus(path: string, status: LiveStatus): void {
  // Write then rename, so a reader never sees a half-written file.
  writeJsonAtomic(path, status);
}

export function readStatus(path: string): LiveStatus | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LiveStatus;
  } catch {
    return null;
  }
}

/** Whether a process with this id is running (the bot's pid from status.json). */
export function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
