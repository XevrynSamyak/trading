import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CycleKind } from "./cycle.js";

/**
 * Probes: in paper mode, a positive gap that is below the trading bar is
 * re-quoted once (both legs, nothing built or sent) to see whether it was
 * still there. That costs two quotes and no money, and gives the brain far
 * more examples of which gaps are real than the few that clear the bar.
 *
 * Probes live in their own file (data/probes-<mode>.jsonl), so they never
 * count toward the go-live gate, P&L or the trading funnel.
 */
export interface ProbeRecord {
  ts: number;
  symbol: string;
  kind: CycleKind;
  /** Venues (DEXes) the route went through, e.g. ["Whirlpool", "GoonFi V2"]. */
  venues: string[];
  sizeUsd: number;
  /** Net after costs at the scan (bps). */
  quotedBps: number;
  /** Net after costs at the re-check (bps). */
  freshBps: number;
  /** Scan quote finished → re-check finished (ms). */
  ageMs: number;
  /** The scan was triggered by a pool change. */
  event: boolean;
}

/** Distinct venue labels in a route string like "Obsidian>Whirlpool | Bonkswap>BisonFi". */
export const venuesOf = (routes: string): string[] =>
  [...new Set(routes.split(/\s*[|>]\s*/).map((s) => s.trim()).filter((s) => s && s !== "?"))];

/** A gap "held" if, at the re-check, it was still positive and at least half its quoted size. */
export const held = (p: Pick<ProbeRecord, "quotedBps" | "freshBps">): boolean =>
  p.freshBps > 0 && p.freshBps >= p.quotedBps / 2;

export class ProbeLog {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(r: ProbeRecord): void {
    appendFileSync(this.path, JSON.stringify(r) + "\n");
  }

  static read(path: string): ProbeRecord[] {
    if (!existsSync(path)) return [];
    const out: ProbeRecord[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as ProbeRecord);
      } catch {
        // torn line
      }
    }
    return out;
  }
}

interface Tally {
  n: number;
  held: number;
  /** Sum of (quoted − fresh) bps: how much the gap shrank by the re-check. */
  decay: number;
}
const tally = (): Tally => ({ n: 0, held: 0, decay: 0 });

const GAP_BUCKETS: [string, number][] = [
  ["0..5", 5],
  ["5..10", 10],
  ["10..20", 20],
  ["20..50", 50],
  ["50+", Infinity],
];
export const gapBucket = (bps: number) => GAP_BUCKETS.find(([, hi]) => bps < hi)?.[0] ?? "50+";
const AGE_BUCKETS: [string, number][] = [
  ["< 0.5 s", 500],
  ["0.5–1 s", 1_000],
  ["1–2 s", 2_000],
  ["2 s+", Infinity],
];
const ageBucket = (ms: number) => AGE_BUCKETS.find(([, hi]) => ms < hi)?.[0] ?? "2 s+";

/** Minimal shape of a funnel record that was re-quoted (see funnel.ts). */
export interface RequotedOpp {
  ts: number;
  symbol: string;
  kind: CycleKind;
  route: string;
  sizeUsd: number;
  quoted: { netBps: number };
  executable?: { netBps: number };
  t: { quoteEnd: number; requoteEnd?: number; market?: number };
}

/** Funnel records with a fresh re-quote count as examples too (same "held" test). */
export function probeFromOpp(o: RequotedOpp): ProbeRecord | null {
  if (!o.executable || o.t.requoteEnd === undefined) return null;
  return {
    ts: o.ts,
    symbol: o.symbol,
    kind: o.kind,
    venues: venuesOf(o.route),
    sizeUsd: o.sizeUsd,
    quotedBps: o.quoted.netBps,
    freshBps: o.executable.netBps,
    ageMs: o.t.requoteEnd - o.t.quoteEnd,
    event: o.t.market !== undefined,
  };
}

/** Enough examples in a group to say something about it. */
const MIN_SAMPLES = 10;

/**
 * What re-checks taught: how often a gap is still there, by gap size, token,
 * venue, re-check delay and trigger. Rates are (held + 1) / (n + 2), so a
 * handful of examples can't produce 0 % or 100 %.
 */
export class GapMemory {
  global = tally();
  byGap: Record<string, Tally> = {};
  byToken: Record<string, Tally> = {};
  byVenue: Record<string, Tally> = {};
  byAge: Record<string, Tally> = {};
  byTrigger: Record<string, Tally> = {};

  static from(probes: ProbeRecord[], opps: RequotedOpp[] = []): GapMemory {
    const m = new GapMemory();
    for (const p of probes) m.observe(p);
    for (const o of opps) {
      const p = probeFromOpp(o);
      if (p) m.observe(p);
    }
    return m;
  }

  observe(p: ProbeRecord): void {
    const groups = [
      this.global,
      (this.byGap[gapBucket(p.quotedBps)] ??= tally()),
      (this.byToken[p.symbol] ??= tally()),
      (this.byAge[ageBucket(p.ageMs)] ??= tally()),
      (this.byTrigger[p.event ? "event" : "poll"] ??= tally()),
      ...p.venues.map((v) => (this.byVenue[v] ??= tally())),
    ];
    const h = held(p);
    for (const t of groups) {
      t.n += 1;
      if (h) t.held += 1;
      t.decay += p.quotedBps - p.freshBps;
    }
  }

  static rate(t: Tally): number {
    return (t.held + 1) / (t.n + 2);
  }

  /**
   * How much less often gaps through these venues hold than gaps overall,
   * as a factor in [0.25, 1]. Only venues with enough examples count; it never
   * raises trust above average (unproven venues stay at 1).
   */
  venueTrust(venues: string[]): number {
    if (this.global.n < MIN_SAMPLES * 2) return 1;
    const g = GapMemory.rate(this.global);
    let factor = 1;
    for (const v of venues) {
      const t = this.byVenue[v];
      if (!t || t.n < MIN_SAMPLES * 2) continue;
      factor = Math.min(factor, GapMemory.rate(t) / g);
    }
    return Math.max(0.25, Math.min(1, factor));
  }

  /** Plain-language lessons, only where there are enough examples. */
  thoughts(): string[] {
    const out: string[] = [];
    const pct = (t: Tally) => `${Math.round((t.held / t.n) * 100)}%`;
    const avgDecay = (t: Tally) => t.decay / t.n;
    if (this.global.n < MIN_SAMPLES) {
      if (this.global.n) out.push(`I've re-checked ${this.global.n} gap(s) so far; I need ${MIN_SAMPLES}+ to judge them.`);
      return out;
    }
    out.push(
      `I re-checked ${this.global.n} gaps: ${pct(this.global)} were still there, and on average they shrank ` +
        `${avgDecay(this.global).toFixed(1)}bps by the re-check.`,
    );
    const big = ["20..50", "50+"].map((b) => this.byGap[b]).filter((t): t is Tally => !!t && t.n >= MIN_SAMPLES);
    for (const t of big) {
      if (t.held / t.n < 0.2) {
        out.push(`Big quoted gaps (20+ bps) held only ${pct(t)} of the time: most are stale quotes, not real chances.`);
        break;
      }
    }
    const venues = Object.entries(this.byVenue).filter(([, t]) => t.n >= MIN_SAMPLES * 2);
    if (venues.length >= 2) {
      venues.sort((a, b) => GapMemory.rate(a[1]) - GapMemory.rate(b[1]));
      const [worst, wt] = venues[0];
      const [bestV, bt] = venues[venues.length - 1];
      if (GapMemory.rate(bt) - GapMemory.rate(wt) > 0.1) {
        out.push(`Gaps through ${worst} held ${pct(wt)} vs ${pct(bt)} through ${bestV}, so I trust ${worst} less.`);
      }
    }
    const ev = this.byTrigger.event;
    const poll = this.byTrigger.poll;
    if (ev && poll && ev.n >= MIN_SAMPLES && poll.n >= MIN_SAMPLES) {
      out.push(`Gaps found right after a pool change held ${pct(ev)}; found by routine scans, ${pct(poll)}.`);
    }
    const fast = this.byAge["< 0.5 s"];
    const slow = this.byAge["1–2 s"] ?? this.byAge["2 s+"];
    if (fast && slow && fast.n >= MIN_SAMPLES && slow.n >= MIN_SAMPLES) {
      out.push(`Re-checked within half a second, ${pct(fast)} held; after a second or more, ${pct(slow)}.`);
    }
    return out;
  }

  /** Rows for the report: survival by gap size. */
  table(): { bucket: string; n: number; heldPct: number; avgDecayBps: number }[] {
    return GAP_BUCKETS.map(([b]) => [b, this.byGap[b]] as const)
      .filter(([, t]) => t && t.n > 0)
      .map(([bucket, t]) => ({ bucket, n: t!.n, heldPct: (t!.held / t!.n) * 100, avgDecayBps: t!.decay / t!.n }));
  }
}

/** Probe pacing: at most `perHour` probes in any rolling hour. */
export class ProbeBudget {
  private times: number[] = [];

  constructor(private readonly perHour: number) {}

  /** Is there room for a probe this hour? (does not use it up) */
  has(now = Date.now()): boolean {
    while (this.times.length && this.times[0] <= now - 3_600_000) this.times.shift();
    return this.times.length < this.perHour;
  }

  /** Uses up one probe if there is room. */
  allow(now = Date.now()): boolean {
    if (!this.has(now)) return false;
    this.times.push(now);
    return true;
  }
}
