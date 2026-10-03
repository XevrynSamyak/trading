import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The bot's learning "brain". No AI API calls (too slow for arbitrage and it
 * would cost money); it learns from its own scans and trades:
 *  - which tokens tend to show price gaps -> scans those more often
 *  - how its trades turn out -> tunes how much profit it demands per trade
 * State is saved to disk so it keeps what it learned across restarts.
 */

export interface TokenStats {
  scans: number;
  /** Exponentially-weighted average of the best net edge seen (bps). */
  avgEdgeBps: number;
  fills: number;
  failures: number;
  pnlUsd: number;
}

export interface BrainState {
  tokens: Record<string, TokenStats>;
  minProfitBps: number;
  totalScans: number;
}

export interface BrainOptions {
  baseMinProfitBps: number;
  /** Bounds the brain may move the profit threshold within. */
  minBps?: number;
  maxBps?: number;
  /** How many tokens to quote per cycle (each costs 2 API calls). */
  tokensPerCycle?: number;
  /** Chance of scanning a random token instead of the best-ranked ones. */
  exploreRate?: number;
  random?: () => number;
}

const EDGE_SMOOTHING = 0.2;

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
      random: Math.random,
      ...opts,
    };
    this.state = this.load() ?? { tokens: {}, minProfitBps: opts.baseMinProfitBps, totalScans: 0 };
  }

  private load(): BrainState | null {
    if (!existsSync(this.path)) return null;
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as BrainState;
    } catch {
      return null;
    }
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }

  private stats(symbol: string): TokenStats {
    return (this.state.tokens[symbol] ??= { scans: 0, avgEdgeBps: 0, fills: 0, failures: 0, pnlUsd: 0 });
  }

  /** UCB-style score: tokens with a good edge rank high; rarely-scanned ones get a curiosity bonus. */
  score(symbol: string): number {
    const s = this.stats(symbol);
    if (s.scans === 0) return Number.POSITIVE_INFINITY;
    const curiosity = 10 * Math.sqrt(Math.log(this.state.totalScans + 1) / s.scans);
    const reliability = s.fills + s.failures > 0 ? s.fills / (s.fills + s.failures) : 0.5;
    return s.avgEdgeBps + curiosity + 5 * reliability;
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

  observeScan(symbol: string, netBps: number): void {
    const s = this.stats(symbol);
    s.avgEdgeBps = s.scans === 0 ? netBps : s.avgEdgeBps * (1 - EDGE_SMOOTHING) + netBps * EDGE_SMOOTHING;
    s.scans += 1;
    this.state.totalScans += 1;
  }

  /** Learns from a trade outcome and adjusts how picky it is. */
  observeTrade(symbol: string, status: "filled" | "skipped" | "failed", netUsd: number): void {
    const s = this.stats(symbol);
    s.pnlUsd += netUsd;
    let bps = this.state.minProfitBps;
    if (status === "failed" || (status === "filled" && netUsd < 0)) {
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

  summary(): string {
    const rows = Object.entries(this.state.tokens)
      .sort(([a], [b]) => this.score(b) - this.score(a))
      .map(([sym, s]) => `${sym}: edge ${s.avgEdgeBps.toFixed(1)}bps, ${s.fills} fills, ${s.failures} fails, $${s.pnlUsd.toFixed(4)}`);
    return [`profit threshold: ${this.state.minProfitBps}bps`, ...rows].join("\n");
  }
}
