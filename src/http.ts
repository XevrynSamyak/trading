import type { FetchFn } from "./jupiter.js";

/** Requests (Jupiter, RPC, Jito, Telegram) give up after this long instead of stalling the bot. */
export const HTTP_TIMEOUT_MS = 15_000;

/**
 * A fetch that aborts after `ms`. Without it a hung connection blocks the
 * main loop for minutes (Node's default), and a gap never waits that long.
 */
export function timeoutFetch(ms = HTTP_TIMEOUT_MS, base: FetchFn = fetch): FetchFn {
  return ((input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const timeout = AbortSignal.timeout(ms);
    const signal = init?.signal && typeof AbortSignal.any === "function" ? AbortSignal.any([init.signal, timeout]) : (init?.signal ?? timeout);
    return base(input, { ...init, signal });
  }) as FetchFn;
}
