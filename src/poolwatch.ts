import { PublicKey, type Connection } from "@solana/web3.js";

/**
 * Event triggers. Instead of only re-quoting tokens in turn, the bot listens
 * (over the RPC's WebSocket) to the pool accounts its routes use. A change in
 * a pool means someone traded there, which is when one venue's price can drift
 * from another's; the token is then marked "dirty" and quoted right away.
 *
 * Costs are capped:
 *  - at most `maxPools` pools are watched (the most promising tokens' routes)
 *  - a pool that changes nearly every slot carries no signal ("always moving")
 *    and costs the most traffic: it is dropped for an hour
 *  - at most `dailyEventCap` notifications a day (each carries the pool's data)
 *  - each token is marked dirty at most once per `debounceMs`
 */
export interface AccountSubscriber {
  subscribe(account: string, onChange: (slot: number) => void): number | Promise<number>;
  unsubscribe(id: number): void | Promise<void>;
}

/** The RPC WebSocket via web3.js (accountSubscribe / accountUnsubscribe). */
export function rpcSubscriber(conn: Connection): AccountSubscriber {
  return {
    subscribe: (account, onChange) => conn.onAccountChange(new PublicKey(account), (_info, ctx) => onChange(ctx.slot), { commitment: "processed" }),
    unsubscribe: (id) => conn.removeAccountChangeListener(id),
  };
}

export interface WatchOptions {
  maxPools: number;
  dailyEventCap: number;
  debounceMs: number;
  /** A pool with more notifications than this in a minute is dropped for `busyCooldownMs`. */
  busyPerMin: number;
  busyCooldownMs?: number;
}

export interface WatchStats {
  watching: number;
  eventsToday: number;
  capped: boolean;
  tooBusy: number;
}

const DAY_MS = 86_400_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export class PoolWatcher {
  /** pool -> subscription id and the tokens whose routes use it */
  private subs = new Map<string, { id: number | null; tokens: Set<string>; times: number[] }>();
  private tooBusy = new Map<string, number>();
  private dirty = new Map<string, number>();
  private lastMarked = new Map<string, number>();
  private day = -1;
  private eventsToday = 0;
  private capped = false;

  constructor(
    private readonly sub: AccountSubscriber,
    private readonly opts: WatchOptions,
    /** Called when a token becomes dirty (wake the main loop). */
    private readonly onDirty: () => void = () => {},
    private readonly now: () => number = Date.now,
    private readonly onWarn: (msg: string) => void = () => {},
  ) {}

  /**
   * Watch the pools of these tokens, most promising first, up to `maxPools`.
   * Pools no longer wanted are unsubscribed.
   */
  async watch(wanted: { symbol: string; pools: string[] }[]): Promise<void> {
    this.rollDay();
    if (this.capped) return;
    const now = this.now();
    const plan = new Map<string, Set<string>>();
    for (const { symbol, pools } of wanted) {
      for (const pool of pools) {
        if ((this.tooBusy.get(pool) ?? 0) > now) continue;
        if (!plan.has(pool) && plan.size >= this.opts.maxPools) continue;
        plan.set(pool, (plan.get(pool) ?? new Set()).add(symbol));
      }
    }
    for (const [pool, s] of [...this.subs]) {
      if (!plan.has(pool)) await this.drop(pool, s.id);
    }
    for (const [pool, tokens] of plan) {
      const existing = this.subs.get(pool);
      if (existing) {
        existing.tokens = tokens;
        continue;
      }
      const entry = { id: null as number | null, tokens, times: [] as number[] };
      this.subs.set(pool, entry);
      try {
        entry.id = await withTimeout(Promise.resolve(this.sub.subscribe(pool, () => this.onEvent(pool))), 5_000);
      } catch (err) {
        this.subs.delete(pool);
        this.onWarn(`could not watch pool ${pool.slice(0, 8)}…: ${String(err).slice(0, 100)}`);
      }
    }
  }

  private async drop(pool: string, id: number | null): Promise<void> {
    this.subs.delete(pool);
    if (id === null) return;
    // Never wait for the reply: the WebSocket library waits forever for it, and on a
    // half-dropped phone connection it never comes, which froze the whole bot.
    try {
      void Promise.resolve(this.sub.unsubscribe(id)).catch(() => {});
    } catch {
      // already gone (e.g. the socket reconnected)
    }
  }

  private rollDay(): void {
    const day = Math.floor(this.now() / DAY_MS);
    if (day !== this.day) {
      this.day = day;
      this.eventsToday = 0;
      this.capped = false;
    }
  }

  private onEvent(pool: string): void {
    this.rollDay();
    const s = this.subs.get(pool);
    if (!s || this.capped) return;
    const now = this.now();
    this.eventsToday += 1;
    if (this.eventsToday >= this.opts.dailyEventCap) {
      this.capped = true;
      this.onWarn(`event triggers paused until tomorrow (UTC): ${this.opts.dailyEventCap} pool updates today`);
      void this.unwatchAll();
      return;
    }
    s.times.push(now);
    while (s.times.length && s.times[0] <= now - 60_000) s.times.shift();
    if (s.times.length > this.opts.busyPerMin) {
      // Changes nearly every slot: no signal in it, and the most traffic. Rest it.
      this.tooBusy.set(pool, now + (this.opts.busyCooldownMs ?? 60 * 60_000));
      void this.drop(pool, s.id);
      return;
    }
    let marked = false;
    for (const token of s.tokens) {
      if (now - (this.lastMarked.get(token) ?? 0) < this.opts.debounceMs) continue;
      this.lastMarked.set(token, now);
      this.dirty.set(token, now);
      marked = true;
    }
    if (marked) this.onDirty();
  }

  /** Dirty tokens and when their pool changed, newest first; clears them. */
  takeDirty(): { symbol: string; ts: number }[] {
    const out = [...this.dirty].map(([symbol, ts]) => ({ symbol, ts })).sort((a, b) => b.ts - a.ts);
    this.dirty.clear();
    return out;
  }

  /** Put a dirty token back (e.g. it could not be quoted this time). */
  remark(symbol: string, ts: number): void {
    if (!this.dirty.has(symbol)) this.dirty.set(symbol, ts);
  }

  stats(): WatchStats {
    this.rollDay();
    const now = this.now();
    return {
      watching: this.subs.size,
      eventsToday: this.eventsToday,
      capped: this.capped,
      tooBusy: [...this.tooBusy.values()].filter((t) => t > now).length,
    };
  }

  async unwatchAll(): Promise<void> {
    for (const [pool, s] of [...this.subs]) await this.drop(pool, s.id);
  }
}
