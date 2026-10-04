import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The bot's learning "brain". No AI API calls (too slow for arbitrage and it
 * would cost money); it learns from its own scans and trades:
 *  - which tokens tend to show price gaps -> scans those more often
 *  - which trade size works best per token -> smaller trades move the price less
 *  - which hours of the day are best -> scans faster then, slower otherwise
 *  - how close it is to a gap -> speeds up when one is nearly there
 *  - how its trades turn out -> tunes how much profit it demands per trade
 *  - which newly discovered tokens are worth keeping -> forgets the useless ones
 *  - which tokens show fake gaps (quotes that don't hold on-chain) -> trusts them less
 *  - how much each token's quotes overstate reality -> discounts its quotes by that
 *  - sudden price moves (when gaps tend to appear) -> watches that token closely
 * It also explains what it noticed in plain language (thoughts()).
 * State is saved to disk so it keeps what it learned across restarts.
 */

/** Trade size as a share of the maximum the wallet allows. */
export const SIZE_BUCKETS = [0.25, 0.5, 1] as const;
export type SizeBucket = (typeof SIZE_BUCKETS)[number];

export interface BucketStats {
  n: number;
  /** Exponentially-weighted average net USD a round trip at this size would make. */
  avgNetUsd: number;
}

export interface TokenStats {
  scans: number;
  /** Exponentially-weighted average of the best net edge seen (bps). */
  avgEdgeBps: number;
  fills: number;
  failures: number;
  pnlUsd: number;
  /** Quoted gaps that were not real when checked on-chain. */
  phantoms: number;
  /** How many bps the quotes overstated the real (on-chain checked) result, on average. */
  haircutBps: number;
  realityChecks: number;
  sizes: Record<string, BucketStats>;
}

export interface Moment {
  symbol: string;
  bps: number;
  at: number;
}

export interface BrainState {
  tokens: Record<string, TokenStats>;
  minProfitBps: number;
  totalScans: number;
  /** Average best edge (bps) seen in each UTC hour; null = not seen yet. */
  hourEdgeBps: (number | null)[];
  /** Tokens it found by itself (symbol -> mint), on top of the configured ones. */
  discovered: Record<string, string>;
  /** How often the best scan of a cycle landed in each edge range (bps). */
  edgeHistogram: Record<string, number>;
  /** When this brain started learning (ms). */
  startedAt: number;
  /** The closest it has come to a profitable gap. */
  bestGap: Moment | null;
  /** Sudden price moves it reacted to. */
  hotEvents: number;
  lastHot: Moment | null;
}

export interface BrainOptions {
  baseMinProfitBps: number;
  /** Bounds the brain may move the profit threshold within. */
  minBps?: number;
  maxBps?: number;
  /** How many tokens to quote per cycle (each costs 2 API calls). */
  tokensPerCycle?: number;
  /** Chance of trying something other than the current best (token or size). */
  exploreRate?: number;
  /** Scan interval bounds for adaptive pacing. */
  minIntervalMs?: number;
  maxIntervalMs?: number;
  random?: () => number;
}

const EDGE_SMOOTHING = 0.2;
const HOUR_SMOOTHING = 0.05;
/** Tries each size this many times before trusting the averages. */
const SIZE_WARMUP = 3;
/** A discovered token this bad after this many scans is dropped. */
const PRUNE_AFTER_SCANS = 50;
const PRUNE_BELOW_BPS = -30;
const HAIRCUT_SMOOTHING = 0.3;
/** A move this big (bps) between two scans of a token marks it "hot". */
const HOT_MOVE_BPS = 30;
/** ...if the two scans were at most this far apart. */
const HOT_WINDOW_MS = 5 * 60_000;
/** How long a hot token gets extra attention. */
const HOT_FOR_MS = 2 * 60_000;

const ewma = (prev: number, next: number, a: number) => prev * (1 - a) + next * a;

/** Edge ranges (bps) for the "how close did gaps get" histogram. */
export const EDGE_BINS: [label: string, upTo: number][] = [
  ["< -20", -20],
  ["-20..-5", -5],
  ["-5..0", 0],
  ["0..5", 5],
  ["5..10", 10],
  ["10..20", 20],
  ["20+", Number.POSITIVE_INFINITY],
];
export const edgeBin = (bps: number): string => EDGE_BINS.find(([, upTo]) => bps < upTo)![0];

export class Brain {
  state: BrainState;
  private readonly opts: Required<BrainOptions>;
  /** Short-term memory (not saved): last price seen per token+size, and hot tokens. */
  private lastRate = new Map<string, { rate: number; at: number }>();
  private hotUntil = new Map<string, number>();

  constructor(
    private readonly path: string,
    opts: BrainOptions,
  ) {
    this.opts = {
      minBps: Math.max(5, Math.floor(opts.baseMinProfitBps / 2)),
      maxBps: opts.baseMinProfitBps * 4,
      tokensPerCycle: 3,
      exploreRate: 0.2,
      minIntervalMs: 8_000,
      maxIntervalMs: 60_000,
      random: Math.random,
      ...opts,
    };
    const loaded = this.load();
    this.state = {
      tokens: {},
      minProfitBps: opts.baseMinProfitBps,
      totalScans: 0,
      ...loaded,
      // Older brain files lack these; fill them in so they upgrade in place.
      hourEdgeBps: loaded?.hourEdgeBps ?? Array(24).fill(null),
      discovered: loaded?.discovered ?? {},
      edgeHistogram: loaded?.edgeHistogram ?? {},
      startedAt: loaded?.startedAt ?? Date.now(),
      bestGap: loaded?.bestGap ?? null,
      hotEvents: loaded?.hotEvents ?? 0,
      lastHot: loaded?.lastHot ?? null,
    };
    for (const s of Object.values(this.state.tokens)) {
      s.sizes ??= {};
      s.phantoms ??= 0;
      s.haircutBps ??= 0;
      s.realityChecks ??= 0;
    }
  }

  private load(): Partial<BrainState> | null {
    if (!existsSync(this.path)) return null;
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Partial<BrainState>;
    } catch {
      return null;
    }
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }

  private stats(symbol: string): TokenStats {
    return (this.state.tokens[symbol] ??= {
      scans: 0,
      avgEdgeBps: 0,
      fills: 0,
      failures: 0,
      pnlUsd: 0,
      phantoms: 0,
      haircutBps: 0,
      realityChecks: 0,
      sizes: {},
    });
  }

  // ---- which tokens -------------------------------------------------------

  /** Configured tokens plus the ones it discovered by itself. */
  tokenPool(configured: Record<string, string>): Record<string, string> {
    return { ...this.state.discovered, ...configured };
  }

  /**
   * Adds newly discovered tokens, after first forgetting discovered tokens that
   * proved useless. Configured tokens are never dropped.
   */
  learnTokens(found: Record<string, string>, configured: Record<string, string>, maxTotal: number): string[] {
    for (const [sym] of Object.entries(this.state.discovered)) {
      const s = this.state.tokens[sym];
      if (s && s.scans >= PRUNE_AFTER_SCANS && s.avgEdgeBps < PRUNE_BELOW_BPS && s.fills === 0) {
        delete this.state.discovered[sym];
      }
    }
    const knownMints = new Set([...Object.values(configured), ...Object.values(this.state.discovered)]);
    const added: string[] = [];
    for (const [sym, mint] of Object.entries(found)) {
      if (Object.keys(this.tokenPool(configured)).length >= maxTotal) break;
      if (knownMints.has(mint) || sym in configured || sym in this.state.discovered) continue;
      this.state.discovered[sym] = mint;
      knownMints.add(mint);
      added.push(sym);
    }
    return added;
  }

  /** UCB-style score: tokens with a good edge rank high; rarely-scanned ones get a curiosity bonus. */
  score(symbol: string): number {
    const s = this.stats(symbol);
    if (s.scans === 0) return Number.POSITIVE_INFINITY;
    const curiosity = 10 * Math.sqrt(Math.log(this.state.totalScans + 1) / s.scans);
    // Tokens whose gaps turn out fake (phantoms) or fail lose trust.
    const tries = s.fills + s.failures + s.phantoms;
    const reliability = tries > 0 ? (s.fills + 0.5) / (tries + 1) : 0.5;
    return s.avgEdgeBps + curiosity + 10 * reliability;
  }

  /** Picks which tokens to scan this cycle. Hot tokens (sudden moves) go first. */
  pickTokens(all: Record<string, string>, now = Date.now()): Record<string, string> {
    const symbols = Object.keys(all);
    const n = Math.min(this.opts.tokensPerCycle, symbols.length);
    const ranked = [...symbols].sort((a, b) => this.score(b) - this.score(a));
    const hot = ranked.filter((s) => this.isHot(s, now));
    const chosen = [...hot, ...ranked.filter((s) => !hot.includes(s))].slice(0, n);
    if (hot.length < n && this.opts.random() < this.opts.exploreRate && symbols.length > n) {
      const rest = ranked.filter((s) => !chosen.includes(s));
      chosen[n - 1] = rest[Math.floor(this.opts.random() * rest.length)];
    }
    return Object.fromEntries(chosen.map((s) => [s, all[s]]));
  }

  // ---- sudden moves -------------------------------------------------------

  /**
   * Watches each token's price between scans (same trade size, so price
   * impact doesn't fake a move). A sharp move marks it hot for a while:
   * that is when gaps between exchanges tend to open.
   */
  observePrice(symbol: string, bucket: SizeBucket, rate: number, now = Date.now()): number | null {
    const key = `${symbol}:${bucket}`;
    const prev = this.lastRate.get(key);
    this.lastRate.set(key, { rate, at: now });
    if (!prev || prev.rate <= 0 || now - prev.at > HOT_WINDOW_MS) return null;
    const moveBps = Math.abs(rate / prev.rate - 1) * 10_000;
    if (moveBps >= HOT_MOVE_BPS) {
      if (!this.isHot(symbol, now)) {
        this.state.hotEvents += 1;
        this.state.lastHot = { symbol, bps: Math.round(moveBps * 10) / 10, at: now };
      }
      this.hotUntil.set(symbol, now + HOT_FOR_MS);
    }
    return moveBps;
  }

  isHot(symbol: string, now = Date.now()): boolean {
    return (this.hotUntil.get(symbol) ?? 0) > now;
  }

  // ---- how much to trust quotes -------------------------------------------

  /**
   * Learns from an on-chain check how much the quote overstated reality.
   * realNetBps is what actually would have been made (0 for a fake gap).
   */
  observeReality(symbol: string, quotedNetBps: number, realNetBps: number): void {
    const s = this.stats(symbol);
    const miss = quotedNetBps - realNetBps;
    s.haircutBps = s.realityChecks === 0 ? miss : ewma(s.haircutBps, miss, HAIRCUT_SMOOTHING);
    s.realityChecks += 1;
  }

  /** The quote, discounted by how much this token's quotes usually overstate reality. */
  expectedNetBps(symbol: string, quotedNetBps: number): number {
    return quotedNetBps - Math.max(0, this.state.tokens[symbol]?.haircutBps ?? 0);
  }

  /**
   * Whether to act on a quoted gap. Uses the discounted value; but if only
   * the discount stands in the way, it still re-checks now and then, since
   * conditions change.
   */
  shouldAttempt(symbol: string, quotedNetBps: number): boolean {
    if (this.expectedNetBps(symbol, quotedNetBps) >= this.minProfitBps) return true;
    return quotedNetBps >= this.minProfitBps && this.opts.random() < this.opts.exploreRate;
  }

  // ---- what size ----------------------------------------------------------

  /**
   * Picks how much of `maxUsd` to trade for this token. Smaller trades move
   * the price less (better %), bigger ones make more per win; it learns which
   * nets the most dollars per token.
   */
  pickSize(symbol: string, maxUsd: number): { usd: number; bucket: SizeBucket } {
    const sizes = this.stats(symbol).sizes;
    let bucket: SizeBucket | undefined = SIZE_BUCKETS.find((b) => (sizes[b]?.n ?? 0) < SIZE_WARMUP);
    if (bucket === undefined) {
      if (this.opts.random() < this.opts.exploreRate) {
        bucket = SIZE_BUCKETS[Math.floor(this.opts.random() * SIZE_BUCKETS.length)];
      } else {
        bucket = [...SIZE_BUCKETS].sort((a, b) => sizes[b].avgNetUsd - sizes[a].avgNetUsd)[0];
      }
    }
    const usd = Math.floor(maxUsd * bucket * 100) / 100;
    // Tiny trades are all fees; fall back to the full size.
    return usd >= 1 ? { usd, bucket } : { usd: maxUsd, bucket: 1 };
  }

  // ---- learning from scans and trades -------------------------------------

  observeScan(symbol: string, netBps: number, netUsd = 0, bucket: SizeBucket = 1, hour = new Date().getUTCHours()): void {
    const s = this.stats(symbol);
    s.avgEdgeBps = s.scans === 0 ? netBps : ewma(s.avgEdgeBps, netBps, EDGE_SMOOTHING);
    s.scans += 1;
    this.state.totalScans += 1;

    const b = (s.sizes[bucket] ??= { n: 0, avgNetUsd: netUsd });
    b.avgNetUsd = b.n === 0 ? netUsd : ewma(b.avgNetUsd, netUsd, EDGE_SMOOTHING);
    b.n += 1;

    const prev = this.state.hourEdgeBps[hour];
    this.state.hourEdgeBps[hour] = prev === null ? netBps : ewma(prev, netBps, HOUR_SMOOTHING);
  }

  /** Records the best edge of a scan cycle for the histogram. */
  observeCycle(bestNetBps: number, symbol = "?", now = Date.now()): void {
    const bin = edgeBin(bestNetBps);
    this.state.edgeHistogram[bin] = (this.state.edgeHistogram[bin] ?? 0) + 1;
    if (!this.state.bestGap || bestNetBps > this.state.bestGap.bps) {
      this.state.bestGap = { symbol, bps: Math.round(bestNetBps * 10) / 10, at: now };
    }
  }

  /** Learns from a trade outcome and adjusts how picky it is. */
  observeTrade(symbol: string, status: "filled" | "rejected" | "skipped" | "failed", netUsd: number): void {
    const s = this.stats(symbol);
    s.pnlUsd += netUsd;
    let bps = this.state.minProfitBps;
    if (status === "rejected") {
      // Gap was fake but cost nothing: trust this token less, threshold unchanged.
      s.phantoms += 1;
    } else if (status === "failed" || (status === "filled" && netUsd < 0)) {
      s.failures += status === "failed" ? 1 : 0;
      bps *= 1.25; // got burned: demand a fatter edge
    } else if (status === "filled") {
      s.fills += 1;
      bps *= 0.95; // working: take slightly thinner edges for more trades
    }
    this.state.minProfitBps = Math.min(this.opts.maxBps, Math.max(this.opts.minBps, Math.round(bps * 10) / 10));
  }

  get minProfitBps(): number {
    return this.state.minProfitBps;
  }

  // ---- when to look -------------------------------------------------------

  /** Better (true) or worse (false) than the typical hour; null if typical or not enough data. */
  isGoodHour(hour: number): boolean | null {
    const known = this.state.hourEdgeBps.filter((v): v is number => v !== null);
    const here = this.state.hourEdgeBps[hour];
    if (known.length < 6 || here === null) return null; // not enough data yet
    const sorted = [...known].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return here > median ? true : here < median ? false : null;
  }

  /**
   * How long to wait before the next scan. Faster when a gap is nearly big
   * enough or in a historically good hour; slower when nothing is close, which
   * also saves the free API quota.
   */
  nextIntervalMs(
    bestNetBps: number | undefined,
    baseMs: number,
    hour = new Date().getUTCHours(),
    now = Date.now(),
  ): number {
    let factor = 1;
    if ([...this.hotUntil.values()].some((until) => until > now)) factor *= 0.6;
    if (bestNetBps !== undefined) {
      const shortBy = this.minProfitBps - bestNetBps;
      if (shortBy <= 5) factor *= 0.5;
      else if (shortBy > 40) factor *= 1.5;
    }
    const good = this.isGoodHour(hour);
    if (good === true) factor *= 0.8;
    else if (good === false) factor *= 1.25;
    return Math.round(Math.min(this.opts.maxIntervalMs, Math.max(this.opts.minIntervalMs, baseMs * factor)));
  }

  // ---- reporting ----------------------------------------------------------

  /** What the brain has noticed and why it acts the way it does, in plain language. */
  thoughts(baseMinProfitBps: number): string[] {
    const t: string[] = [];
    const fmtTime = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace("T", " ") + " UTC";
    const bps = this.state.minProfitBps;

    t.push(
      `I only trade when a gap pays at least ${bps}bps (${(bps / 100).toFixed(2)}%) after fees` +
        (bps > baseMinProfitBps ? ", stricter than at the start because some trades went badly." : "") +
        (bps < baseMinProfitBps ? ", looser than at the start because trades have been working." : "."),
    );

    const best = this.state.bestGap;
    if (best) {
      t.push(
        best.bps >= bps
          ? `The best gap I've seen was ${best.symbol} at +${best.bps}bps (${fmtTime(best.at)}).`
          : `The closest I've come is ${best.symbol} at ${best.bps}bps (${fmtTime(best.at)}); I need ${bps}. ` +
              `The market hasn't offered a profitable gap yet.`,
      );
    }

    const liars = Object.entries(this.state.tokens)
      .filter(([, s]) => s.realityChecks >= 3 && s.haircutBps > 1)
      .sort(([, a], [, b]) => b.haircutBps - a.haircutBps)
      .slice(0, 2);
    for (const [sym, s] of liars) {
      t.push(
        `${sym}'s quotes look ~${s.haircutBps.toFixed(1)}bps better than what really happens on-chain, ` +
          `so I discount them by that.`,
      );
    }

    const fakest = Object.entries(this.state.tokens)
      .filter(([, s]) => s.phantoms >= 3)
      .sort(([, a], [, b]) => b.phantoms - a.phantoms)[0];
    if (fakest) t.push(`${fakest[0]} showed ${fakest[1].phantoms} fake gaps, so I check it less often.`);

    if (this.state.lastHot) {
      const h = this.state.lastHot;
      t.push(
        `I've reacted to ${this.state.hotEvents} sudden price move(s); the latest was ${h.symbol} ` +
          `moving ${(h.bps / 100).toFixed(2)}% within minutes (${fmtTime(h.at)}), so I watched it closely.`,
      );
    }

    const hours = this.state.hourEdgeBps
      .map((v, h) => [h, v] as const)
      .filter((x): x is readonly [number, number] => x[1] !== null);
    if (hours.length >= 6) {
      const [h] = [...hours].sort((a, b) => b[1] - a[1])[0];
      t.push(`Gaps have been best around ${h}:00 UTC, so I scan faster then.`);
    }

    const found = Object.keys(this.state.discovered);
    if (found.length) t.push(`I found ${found.length} extra token(s) to watch by myself: ${found.join(", ")}.`);

    const favourite = Object.keys(this.state.tokens).sort((a, b) => this.score(b) - this.score(a))[0];
    if (favourite && this.state.totalScans > 20) t.push(`Right now ${favourite} looks most promising to me.`);

    return t;
  }

  summary(): string {
    const lines = [`profit threshold: ${this.state.minProfitBps}bps`];

    const hours = this.state.hourEdgeBps
      .map((v, h) => [h, v] as const)
      .filter((x): x is readonly [number, number] => x[1] !== null)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    if (hours.length) {
      lines.push(`best hours (UTC): ${hours.map(([h, v]) => `${h}:00 (${v.toFixed(1)}bps)`).join(", ")}`);
    }

    const total = Object.values(this.state.edgeHistogram).reduce((a, b) => a + b, 0);
    if (total) {
      const parts = EDGE_BINS.map(([label]) => [label, this.state.edgeHistogram[label] ?? 0] as const)
        .filter(([, n]) => n > 0)
        .map(([label, n]) => `${label}: ${((n / total) * 100).toFixed(1)}%`);
      lines.push(`best gap per scan (bps): ${parts.join(", ")}`);
    }

    const discovered = Object.keys(this.state.discovered);
    if (discovered.length) lines.push(`found by itself: ${discovered.join(", ")}`);

    for (const [sym, s] of Object.entries(this.state.tokens).sort(([a], [b]) => this.score(b) - this.score(a))) {
      const best = Object.entries(s.sizes).sort(([, a], [, b]) => b.avgNetUsd - a.avgNetUsd)[0];
      const size = best ? `, best size ${Math.round(Number(best[0]) * 100)}%` : "";
      lines.push(
        `${sym}: edge ${s.avgEdgeBps.toFixed(1)}bps, ${s.fills} fills, ${s.failures} fails, ` +
          `${s.phantoms} fake gaps, $${s.pnlUsd.toFixed(4)}${size}` +
          (s.realityChecks ? `, quotes discounted ${Math.max(0, s.haircutBps).toFixed(1)}bps` : ""),
      );
    }
    return lines.join("\n");
  }
}
