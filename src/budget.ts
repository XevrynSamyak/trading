import type { FetchFn } from "./jupiter.js";

/** Extra wait after the oldest request leaves a window (timers can fire a little early). */
const SAFETY_MS = 100;

export interface RateWindow {
  ms: number;
  limit: number;
}

/**
 * Exact sliding-window request counter over one or more windows (e.g. per
 * minute and per 10 seconds). It tracks every request the bot sends, so the
 * bot can use its allowance without ever going over any of the limits.
 */
export class RequestBudget {
  private times: number[] = [];
  readonly windows: RateWindow[];

  /** A number means one 60-second window with that limit. */
  constructor(limits: number | RateWindow[]) {
    this.windows = typeof limits === "number" ? [{ ms: 60_000, limit: limits }] : limits;
  }

  private prune(now: number): void {
    const longest = Math.max(...this.windows.map((w) => w.ms));
    while (this.times.length && this.times[0] <= now - longest) this.times.shift();
  }

  record(now = Date.now()): void {
    this.times.push(now);
  }

  /** Requests sent in the `windowMs` ending at `now`. */
  used(now = Date.now(), windowMs = 60_000): number {
    this.prune(now);
    return this.times.filter((t) => t > now - windowMs).length;
  }

  /** How long to wait (ms) before `n` more requests fit in every window. */
  waitFor(n: number, now = Date.now()): number {
    this.prune(now);
    let wait = 0;
    for (const w of this.windows) {
      const inWindow = this.times.filter((t) => t > now - w.ms);
      const need = Math.min(n, w.limit);
      const room = w.limit - inWindow.length;
      if (need <= room) continue;
      const mustExpire = Math.min(need - room, inWindow.length);
      wait = Math.max(wait, inWindow[mustExpire - 1] + w.ms - now + SAFETY_MS);
    }
    return wait;
  }
}

/** A fetch that records every request against the budget. */
export function budgetedFetch(budget: RequestBudget, fetchFn: FetchFn = fetch): FetchFn {
  return ((input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    budget.record();
    return fetchFn(input, init);
  }) as FetchFn;
}
