import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Mode } from "./config.js";
import type { Valuation } from "./costs.js";
import type { Cycle, CycleKind } from "./cycle.js";
import type { ExecResult, ExecStatus } from "./executor.js";
import { tailLines } from "./tail.js";

/**
 * The opportunity funnel. Every candidate the bot acts on gets an ID and ONE
 * structured line in data/opps-<mode>.jsonl recording how far it got:
 *
 *   quoted → executable → simulated → submitted → landed → profitable
 *
 *   quoted      the scan's quotes showed a gap above the bar (NOT profit)
 *   executable  every leg re-quoted moments later still cleared the floor
 *   simulated   the exact transaction simulated OK on the real chain
 *   submitted   a real transaction was sent (micro/live)
 *   landed      it landed on-chain
 *   profitable  it landed and the wallet gained after all fees
 */
export type Stage = "quoted" | "executable" | "simulated" | "submitted" | "landed" | "profitable";
export const STAGES: Stage[] = ["quoted", "executable", "simulated", "submitted", "landed", "profitable"];

export interface OppTimes {
  /** Market change that prompted the quote (event-driven), if known. */
  market?: number;
  quoteStart: number;
  quoteEnd: number;
  decision: number;
  requoteStart?: number;
  requoteEnd?: number;
  built?: number;
  submitted?: number;
  landed?: number;
  confirmed?: number;
}

export interface OppLatency {
  marketToQuoteMs?: number;
  quoteMs: number;
  quoteToDecisionMs: number;
  decisionToSubmitMs?: number;
  submitToLandingMs?: number;
  /** Market (or quote start) to landing, or to the last stage reached. */
  totalMs: number;
}

export interface Amount {
  netUsd: number;
  netBps: number;
}

export interface OppRecord {
  id: string;
  ts: number;
  mode: Mode;
  kind: CycleKind;
  symbol: string;
  tokens: string[];
  route: string;
  sizeUsd: number;
  /** From the scan's quotes. An estimate after costs — never profit. */
  quoted: Amount & { grossBps: number };
  /** Fresh re-quote of every leg right before building. */
  executable?: Amount & { grossBps: number };
  /** On-chain simulation of the exact transaction. */
  simulated?: Amount & { ok: boolean };
  /** Real money (micro/live). */
  realized?: Amount & { landed: boolean; signature?: string };
  /** What the learner expected before acting. */
  expected: { pSuccess: number; evUsd: number; assumed: string[] };
  costs: {
    baseFeeUsd: number;
    priorityFeeUsd: number;
    tipUsd: number;
    tipLamports: number;
    bufferUsd: number;
    totalUsd: number;
    dexFeeBps: number;
    priceImpactBps: number;
  };
  /** Sizes evaluated before choosing (filled by the size ladder). */
  ladder?: { sizeUsd: number; netUsd: number; netBps: number; evUsd: number; impactBps: number }[];
  failedLeg?: number;
  stage: Stage;
  result: ExecStatus;
  reason?: string;
  t: OppTimes;
  lat: OppLatency;
}

/** Furthest funnel stage a result reached. */
export function stageOf(result: ExecResult, realMoney: boolean): Stage {
  const st = result.status;
  if (realMoney) {
    if (st === "filled") return result.netUsd > 0 ? "profitable" : "landed";
    if (st === "failed") return "landed";
    if (result.signature) return "submitted"; // sent but did not land / timed out
    if (st === "rejected") return "executable"; // re-quote passed, simulation said no
    return result.executable && st !== "stale" ? "executable" : "quoted";
  }
  if (st === "filled" && result.verified) return "simulated";
  if (st === "filled" || st === "rejected") return "executable";
  return "quoted"; // stale or skipped before/at re-quote
}

export function latencies(t: OppTimes): OppLatency {
  const start = t.market ?? t.quoteStart;
  const end = t.landed ?? t.submitted ?? t.built ?? t.requoteEnd ?? t.decision;
  return {
    marketToQuoteMs: t.market !== undefined ? t.quoteEnd - t.market : undefined,
    quoteMs: t.quoteEnd - t.quoteStart,
    quoteToDecisionMs: t.decision - t.quoteEnd,
    decisionToSubmitMs: t.submitted !== undefined ? t.submitted - t.decision : undefined,
    submitToLandingMs: t.landed !== undefined && t.submitted !== undefined ? t.landed - t.submitted : undefined,
    totalMs: end - start,
  };
}

const amt = (v: Valuation) => ({ netUsd: v.netUsd, netBps: v.netBps, grossBps: v.grossBps });

/** Builds the funnel line for one acted-on candidate. */
export function buildOppRecord(args: {
  id: string;
  mode: Mode;
  cycle: Cycle;
  val: Valuation;
  result: ExecResult;
  decisionTs: number;
  expected: OppRecord["expected"];
  solPriceUsd: number;
  ladder?: OppRecord["ladder"];
}): OppRecord {
  const { cycle, val, result, mode } = args;
  const realMoney = mode !== "paper";
  const bpsOf = (usd: number) => (val.inUsd > 0 ? (usd / val.inUsd) * 10_000 : 0);
  const t: OppTimes = {
    market: cycle.marketTs,
    quoteStart: cycle.quoteStartedAt,
    quoteEnd: cycle.quotedAt,
    decision: args.decisionTs,
    requoteStart: result.t.requoteStart,
    requoteEnd: result.t.requoteEnd,
    built: result.t.built,
    submitted: result.t.submitted,
    landed: result.t.landed,
    confirmed: result.t.confirmed,
  };
  const lamportsUsd = (l: number) => (l / 1e9) * args.solPriceUsd;
  const simulated =
    result.simulatedNetUsd !== undefined
      ? { netUsd: result.simulatedNetUsd, netBps: bpsOf(result.simulatedNetUsd), ok: true }
      : result.verified && !realMoney && result.status === "rejected"
        ? { netUsd: 0, netBps: 0, ok: false }
        : undefined;
  const landed = realMoney && (result.status === "filled" || result.status === "failed");
  return {
    id: args.id,
    ts: args.decisionTs,
    mode,
    kind: cycle.kind,
    symbol: cycle.symbol,
    tokens: cycle.tokens,
    route: cycle.routes,
    sizeUsd: val.inUsd,
    quoted: amt(val),
    executable: result.executable ? amt(result.executable) : undefined,
    simulated,
    realized: realMoney && (landed || result.signature)
      ? { netUsd: result.netUsd, netBps: bpsOf(result.netUsd), landed, signature: result.signature }
      : undefined,
    expected: args.expected,
    costs: {
      baseFeeUsd: lamportsUsd(val.costs.baseFeeLamports),
      priorityFeeUsd: lamportsUsd(val.costs.priorityFeeLamports),
      tipUsd: val.costs.tipUsd,
      tipLamports: val.costs.tipLamports,
      bufferUsd: val.costs.bufferUsd,
      totalUsd: val.costs.totalUsd,
      dexFeeBps: cycle.dexFeeBps,
      priceImpactBps: cycle.priceImpactBps,
    },
    ladder: args.ladder,
    failedLeg: result.failedLeg,
    stage: stageOf(result, realMoney),
    result: result.status,
    reason: result.reason,
    t,
    lat: latencies(t),
  };
}

/** Append-only funnel log with daily opportunity IDs: opp_YYYYMMDD_NNNNNN. */
export class Funnel {
  private day = "";
  private seq = 0;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    // Continue today's numbering after a restart.
    const last = tailLines(path, 1)[0];
    if (last) {
      try {
        const m = (JSON.parse(last) as OppRecord).id.match(/^opp_(\d{8})_(\d+)$/);
        if (m) {
          this.day = m[1];
          this.seq = Number(m[2]);
        }
      } catch {
        // torn last line: start a fresh sequence
      }
    }
  }

  nextId(now = Date.now()): string {
    const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
    if (day !== this.day) {
      this.day = day;
      this.seq = 0;
    }
    this.seq += 1;
    return `opp_${day}_${String(this.seq).padStart(6, "0")}`;
  }

  record(r: OppRecord): void {
    appendFileSync(this.path, JSON.stringify(r) + "\n");
  }

  static read(path: string): OppRecord[] {
    if (!existsSync(path)) return [];
    const out: OppRecord[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as OppRecord);
      } catch {
        // skip a torn line
      }
    }
    return out;
  }
}
