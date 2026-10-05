import type { Mode } from "./config.js";
import { STAGES, type OppRecord } from "./funnel.js";

/**
 * Learning engine V2: success rates for every funnel step, learned from what
 * actually happened (data/opps-<mode>.jsonl is the source of truth and is
 * replayed at startup).
 *
 * Each rate is a Beta-posterior mean shrunk toward the global rate, so a
 * token with 2 samples doesn't swing wildly:
 *     rate = (successes + k·m) / (trials + k),   m = global rate, k = 4
 * Steps never observed yet (e.g. landing before any real trade) use an
 * explicit prior and are listed as "assumed".
 */
export interface Counts {
  n: number;
  executable: number;
  simTried: number;
  simOk: number;
  submitted: number;
  landed: number;
  profitable: number;
  sumQuotedBps: number;
  nExec: number;
  sumExecBps: number;
  nSim: number;
  sumSimBps: number;
  nReal: number;
  sumRealBps: number;
  realizedUsd: number;
  sumLatencyMs: number;
  nLatency: number;
}

const empty = (): Counts => ({
  n: 0, executable: 0, simTried: 0, simOk: 0, submitted: 0, landed: 0, profitable: 0,
  sumQuotedBps: 0, nExec: 0, sumExecBps: 0, nSim: 0, sumSimBps: 0, nReal: 0, sumRealBps: 0, realizedUsd: 0,
  sumLatencyMs: 0, nLatency: 0,
});

const PRIOR_STRENGTH = 4;

export interface Priors {
  /** Assumed chance a simulated-OK transaction lands, until real trades say otherwise. */
  landing: number;
  /** Assumed chance a landed trade is profitable (the on-chain floor makes this high). */
  profitGivenLanded: number;
  /** Assumed chance the exact transaction simulates OK, until simulations say otherwise. */
  simulation: number;
}

export const DEFAULT_PRIORS: Priors = { landing: 0.5, profitGivenLanded: 0.9, simulation: 0.5 };

export interface Probabilities {
  executable: number;
  simulation: number;
  landing: number;
  profit: number;
  /** Chance an attempt ends as intended in this mode. */
  success: number;
  /** Steps with no data yet, filled with priors. */
  assumed: string[];
}

/** Size buckets for statistics, by upper bound in USD. */
const SIZE_BOUNDS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
export const sizeBucket = (usd: number) => {
  const b = SIZE_BOUNDS.find((x) => usd <= x);
  return b === undefined ? ">5000" : `<=${b}`;
};

/** Route signature: the venues per leg, ignoring amounts. */
export const routeKey = (route: string) => route;

export class LearningStats {
  global = empty();
  byToken: Record<string, Counts> = {};
  byRoute: Record<string, Counts> = {};
  bySize: Record<string, Counts> = {};
  byHour: Record<string, Counts> = {};

  constructor(private readonly priors: Priors = DEFAULT_PRIORS) {}

  static fromRecords(records: OppRecord[], priors?: Priors): LearningStats {
    const s = new LearningStats(priors);
    for (const r of records) s.observe(r);
    return s;
  }

  observe(r: OppRecord): void {
    const keys: Counts[] = [
      this.global,
      (this.byToken[r.symbol] ??= empty()),
      (this.byRoute[routeKey(r.route)] ??= empty()),
      (this.bySize[sizeBucket(r.sizeUsd)] ??= empty()),
      (this.byHour[String(new Date(r.ts).getUTCHours())] ??= empty()),
    ];
    const stage = STAGES.indexOf(r.stage);
    const realMoney = r.mode !== "paper";
    for (const c of keys) {
      c.n += 1;
      c.sumQuotedBps += r.quoted.netBps;
      if (r.executable) {
        c.nExec += 1;
        c.sumExecBps += r.executable.netBps;
      }
      if (stage >= STAGES.indexOf("executable")) c.executable += 1;
      // Simulation outcome: explicit in paper; in real modes "sent" means it simulated OK.
      if (r.simulated) {
        c.simTried += 1;
        if (r.simulated.ok) {
          c.simOk += 1;
          c.nSim += 1;
          c.sumSimBps += r.simulated.netBps;
        }
      } else if (realMoney && stage >= STAGES.indexOf("executable")) {
        c.simTried += 1;
        if (stage >= STAGES.indexOf("submitted")) c.simOk += 1;
      }
      if (stage >= STAGES.indexOf("submitted")) c.submitted += 1;
      if (r.realized?.landed) {
        c.landed += 1;
        c.nReal += 1;
        c.sumRealBps += r.realized.netBps;
        c.realizedUsd += r.realized.netUsd;
        if (r.realized.netUsd > 0) c.profitable += 1;
      }
      if (Number.isFinite(r.lat?.totalMs)) {
        c.sumLatencyMs += r.lat.totalMs;
        c.nLatency += 1;
      }
    }
  }

  /** Beta-posterior mean for successes/trials, shrunk toward the global rate (or a prior when there is none). */
  private rate(s: number, n: number, gs: number, gn: number, prior: number): { p: number; assumed: boolean } {
    if (gn === 0) return { p: prior, assumed: true };
    const m = (gs + 1) / (gn + 2);
    return { p: (s + PRIOR_STRENGTH * m) / (n + PRIOR_STRENGTH), assumed: false };
  }

  probabilities(symbol: string, route: string | undefined, mode: Mode, withWallet: boolean): Probabilities {
    const g = this.global;
    const pick = (c: Counts | undefined) => c ?? empty();
    const tok = pick(this.byToken[symbol]);
    const rt = route ? this.byRoute[routeKey(route)] : undefined;
    const blend = (f: (c: Counts) => { p: number; assumed: boolean }) => {
      const a = f(tok);
      // Blend in the route's own history once it has a few samples.
      if (rt && rt.n >= 5) {
        const b = f(rt);
        return { p: (a.p + b.p) / 2, assumed: a.assumed && b.assumed };
      }
      return a;
    };
    const exec = blend((c) => this.rate(c.executable, c.n, g.executable, g.n, 0.5));
    const sim = blend((c) => this.rate(c.simOk, c.simTried, g.simOk, g.simTried, this.priors.simulation));
    const land = blend((c) => this.rate(c.landed, c.submitted, g.landed, g.submitted, this.priors.landing));
    const profit = blend((c) => this.rate(c.profitable, c.landed, g.profitable, g.landed, this.priors.profitGivenLanded));
    const assumed: string[] = [];
    let success = exec.p;
    if (exec.assumed) assumed.push("executable");
    if (mode !== "paper" || withWallet) {
      success *= sim.p;
      if (sim.assumed) assumed.push("simulation");
    }
    if (mode !== "paper") {
      success *= land.p * profit.p;
      if (land.assumed) assumed.push("landing");
      if (profit.assumed) assumed.push("profit");
    }
    return { executable: exec.p, simulation: sim.p, landing: land.p, profit: profit.p, success, assumed };
  }

  /**
   * Expected value of an attempt. Paper: chance it holds × net. Real money:
   * also landing and profit chances; a landed-but-failed trade costs its
   * network fee, a dropped one costs nothing.
   */
  expectedValue(netUsd: number, networkUsd: number, p: Probabilities, mode: Mode, withWallet: boolean): number {
    if (mode === "paper") return (withWallet ? p.executable * p.simulation : p.executable) * netUsd;
    const reach = p.executable * p.simulation * p.landing;
    return reach * (p.profit * netUsd - (1 - p.profit) * networkUsd);
  }

  /** Typical time from market/quote to the last stage reached, ms. */
  medianishLatencyMs(fallback = 1_500): number {
    return this.global.nLatency ? this.global.sumLatencyMs / this.global.nLatency : fallback;
  }

  /** Per-token table: quoted vs executable vs simulated/realized edge and success rate. */
  table(): { symbol: string; n: number; quotedBps: number; execBps: number | null; realBps: number | null; realKind: string; successPct: number }[] {
    return Object.entries(this.byToken)
      .map(([symbol, c]) => {
        const realKind = c.nReal ? "realized" : c.nSim ? "simulated" : "-";
        const realBps = c.nReal ? c.sumRealBps / c.nReal : c.nSim ? c.sumSimBps / c.nSim : null;
        const success = c.nReal ? c.profitable / Math.max(1, c.submitted) : c.simTried ? c.simOk / c.simTried : c.executable / c.n;
        return {
          symbol,
          n: c.n,
          quotedBps: c.sumQuotedBps / c.n,
          execBps: c.nExec ? c.sumExecBps / c.nExec : null,
          realBps,
          realKind,
          successPct: success * 100,
        };
      })
      .sort((a, b) => b.n - a.n);
  }
}

/**
 * Opportunity score for ranking: expected value, discounted for stale quotes,
 * slow expected execution, high price impact and unproven (discovered) tokens.
 * Negative EV stays negative so it is never chosen.
 */
export function scoreOpportunity(a: {
  evUsd: number;
  quoteAgeMs: number;
  expectedLatencyMs: number;
  priceImpactBps: number;
  maxImpactBps: number;
  discovered: boolean;
}): number {
  if (a.evUsd <= 0) return a.evUsd;
  const fresh = 1 / (1 + a.quoteAgeMs / 1_000);
  const speed = 1 / (1 + a.expectedLatencyMs / 2_000);
  const impact = a.maxImpactBps > 0 ? Math.max(0, 1 - a.priceImpactBps / a.maxImpactBps) : 1;
  const known = a.discovered ? 0.8 : 1;
  return a.evUsd * fresh * speed * impact * known;
}
