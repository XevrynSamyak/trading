import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Mode } from "./config.js";

/** Snapshot the bot writes after every cycle so `npm run status` can show live progress. */
export interface LiveStatus {
  pid: number;
  mode: Mode;
  startedAt: number;
  updatedAt: number;
  cycles: number;
  state: "scanning" | "paused" | "waiting" | "stopped";
  note?: string;
  onChainTesting: boolean;
  sendVia: string;
  solPrice: number;
  walletValueUsd: number;
  tradeSizeUsd: number;
  lastBest?: { symbol: string; netBps: number; expectedBps: number; needBps: number };
  hot: string[];
  nextScanInMs: number;
  /** Fastest safe pace the brain has learned (ms between scans). */
  paceFloorMs?: number;
}

export function writeStatus(path: string, status: LiveStatus): void {
  mkdirSync(dirname(path), { recursive: true });
  // Write then rename, so a reader never sees a half-written file.
  writeFileSync(`${path}.tmp`, JSON.stringify(status));
  renameSync(`${path}.tmp`, path);
}

export function readStatus(path: string): LiveStatus | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LiveStatus;
  } catch {
    return null;
  }
}
