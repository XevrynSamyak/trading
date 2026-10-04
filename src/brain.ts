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
  sizes: Record<string, BucketStats>;
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
    };
    for (const s of Object.values(this.state.tokens)) {
      s.sizes ??= {};
      s.phantoms ??= 0;
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

  /** Picks which tokens to scan this cycle. */
  pickTokens(all: Record<string, string>): Record<string, string> {
    const symbols = Object.keys(all);
    const n = Math.min(this.opts.tokensPerCycle, symbols.length);
    const ranked = [...symbols].sort((a, b) => this.score(b) - this.score(a));
    const chosen = ranked.slice(0, n);
    if (this.opts.random() < this.opts.exploreRate && symbols.length > n) {
      const rest = ranked.slice(n);
      chosen[n - 1] = rest[Math.floor(this.opts.random() * rest.length)];
    }
    return Object.fromEntries(chosen.map((s) => [s, all[s]]));
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
  observeCycle(bestNetBps: number): void {
    const bin = edgeBin(bestNetBps);
    this.state.edgeHistogram[bin] = (this.state.edgeHistogram[bin] ?? 0) + 1;
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
  nextIntervalMs(bestNetBps: number | undefined, baseMs: number, hour = new Date().getUTCHours()): number {
    let factor = 1;
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
          `${s.phantoms} fake gaps, $${s.pnlUsd.toFixed(4)}${size}`,
      );
    }
    return lines.join("\n");
  }
}
