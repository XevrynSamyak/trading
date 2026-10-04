import type { FetchFn } from "./jupiter.js";

/**
 * Exact sliding-window request counter. Jupiter counts requests over any
 * 60-second window; this tracks every request the bot sends so it can use
 * the whole allowance without ever going over it.
 */
export class RequestBudget {
  private times: number[] = [];

  constructor(
    readonly limitPerWindow: number,
    private readonly windowMs = 60_000,
  ) {}

  private prune(now: number): void {
    while (this.times.length && this.times[0] <= now - this.windowMs) this.times.shift();
  }

  record(now = Date.now()): void {
    this.times.push(now);
  }

  /** Requests sent in the window ending at `now`. */
  used(now = Date.now()): number {
    this.prune(now);
    return this.times.length;
  }

  /** How long to wait (ms) before `n` more requests fit in the window. */
  waitFor(n: number, now = Date.now()): number {
    this.prune(now);
    const room = this.limitPerWindow - this.times.length;
    if (n <= room) return 0;
    const mustExpire = Math.min(n - room, this.times.length);
    return this.times[mustExpire - 1] + this.windowMs - now + 1;
  }
}

/** A fetch that records every request against the budget. */
export function budgetedFetch(budget: RequestBudget, fetchFn: FetchFn = fetch): FetchFn {
  return ((input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    budget.record();
    return fetchFn(input, init);
  }) as FetchFn;
}
