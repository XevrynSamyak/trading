import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Global emergency stop. While data/TRADING_DISABLED exists the bot does
 * nothing but wait. It is created by `npm run stop-trading`, or by the bot
 * itself when something unexpected happens (a real trade whose landing can't
 * be confirmed, a loss far beyond what the floor allows). Only a person can
 * re-enable trading: `npm run enable-trading`.
 */
export const KILL_FILE = "TRADING_DISABLED";
export const HALT_FILE = "HALTED";

export const killSwitchPath = (dataDir: string) => join(dataDir, KILL_FILE);

export function tradingDisabled(dataDir: string): { disabled: boolean; reason?: string } {
  const p = killSwitchPath(dataDir);
  if (!existsSync(p)) return { disabled: false };
  try {
    return { disabled: true, reason: readFileSync(p, "utf8").trim() || "no reason recorded" };
  } catch {
    // Deleted between the two calls (re-enabled), or unreadable: only the latter stays disabled.
    return existsSync(p) ? { disabled: true, reason: "kill switch file is unreadable" } : { disabled: false };
  }
}

export function disableTrading(dataDir: string, reason: string, now = new Date()): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(killSwitchPath(dataDir), `${now.toISOString()} ${reason}\n`);
}

/** Returns true if trading was disabled and is now re-enabled. */
export function enableTrading(dataDir: string): boolean {
  const p = killSwitchPath(dataDir);
  if (!existsSync(p)) return false;
  rmSync(p);
  return true;
}

export function halted(dataDir: string): string | null {
  const p = join(dataDir, HALT_FILE);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8").trim() || "no reason recorded";
  } catch {
    return "halt file is unreadable";
  }
}
