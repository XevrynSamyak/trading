import { join } from "node:path";
import { readJsonWithBackup } from "./atomic.js";
import type { Config } from "./config.js";
import { Funnel, type OppRecord } from "./funnel.js";
import { halted, tradingDisabled } from "./killswitch.js";

/**
 * The go-live gate. Paper profits are never evidence:
 *
 *  MICRO (tiny real trades) is recommended only after enough trades were
 *  simulated ON-CHAIN, enough of them succeeded, and they made money on
 *  average after every cost.
 *
 *  LIVE (adaptive size) is ALLOWED only after enough MICRO trades landed,
 *  most were profitable, realized P&L is positive, and nothing unexpected
 *  happened. The bot refuses to start LIVE otherwise.
 */
export interface GateThresholds {
  minPaperDays: number;
  minSimulated: number;
  minSimSuccessRate: number;
  microMinTrades: number;
  microMinProfitableRate: number;
}

export interface GateInput {
  paper: OppRecord[];
  micro: OppRecord[];
  paperDays: number;
  killSwitch: string | null;
  halted: string | null;
}

export interface Verdict {
  micro: { ok: boolean; reasons: string[] };
  live: { ok: boolean; reasons: string[] };
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function goLiveVerdict(i: GateInput, t: GateThresholds): Verdict {
  const blockers: string[] = [];
  if (i.killSwitch) blockers.push(`trading is disabled: ${i.killSwitch}`);
  if (i.halted) blockers.push(`the bot is halted: ${i.halted}`);

  const micro = [...blockers];
  const sims = i.paper.filter((r) => r.simulated);
  const ok = sims.filter((r) => r.simulated!.ok);
  if (!sims.length) {
    micro.push("no on-chain simulation data yet: set WALLET_PUBLIC_KEY to a funded wallet so paper mode tests every trade on-chain");
  } else {
    if (sims.length < t.minSimulated) micro.push(`only ${sims.length} trades simulated on-chain (need ${t.minSimulated})`);
    const rate = ok.length / sims.length;
    if (rate < t.minSimSuccessRate) micro.push(`only ${pct(rate)} of simulated trades succeeded (need ${pct(t.minSimSuccessRate)})`);
    const avg = mean(ok.map((r) => r.simulated!.netBps));
    if (ok.length && avg <= 0) micro.push(`simulated trades lose money on average after costs (${avg.toFixed(1)}bps)`);
    if (!ok.length) micro.push("no simulated trade succeeded");
  }
  if (i.paperDays < t.minPaperDays) micro.push(`only ${i.paperDays.toFixed(1)} days of paper data (need ${t.minPaperDays})`);

  const live = [...blockers];
  const landed = i.micro.filter((r) => r.realized?.landed);
  const profitable = landed.filter((r) => r.realized!.netUsd > 0);
  const pnl = landed.reduce((s, r) => s + r.realized!.netUsd, 0);
  const timeouts = i.micro.filter((r) => r.result === "timeout").length;
  if (landed.length < t.microMinTrades) {
    live.push(`Insufficient real execution sample: ${landed.length} MICRO trades landed (need ${t.microMinTrades})`);
  }
  if (landed.length) {
    const rate = profitable.length / landed.length;
    if (rate < t.microMinProfitableRate) {
      live.push(`only ${pct(rate)} of MICRO trades were profitable (need ${pct(t.microMinProfitableRate)})`);
    }
    if (pnl <= 0) live.push(`MICRO realized P&L is $${pnl.toFixed(4)} (must be positive)`);
  }
  if (timeouts) live.push(`${timeouts} MICRO trade(s) had an unconfirmed landing`);

  return { micro: { ok: micro.length === 0, reasons: micro }, live: { ok: live.length === 0, reasons: live } };
}

export function gateThresholds(cfg: Config): GateThresholds {
  return {
    minPaperDays: cfg.gateMinPaperDays,
    minSimulated: cfg.gateMinSimulated,
    minSimSuccessRate: cfg.gateMinSimSuccessRate,
    microMinTrades: cfg.gateMicroMinTrades,
    microMinProfitableRate: cfg.gateMicroMinProfitableRate,
  };
}

const DAY_MS = 86_400_000;

/**
 * Everything the gate looks at, read from the data folder: the paper and
 * MICRO funnels, how long paper testing has run, the kill switch and halt.
 * `read` lets a refreshing screen pass a cached reader.
 */
export function loadGateInput(dataDir: string, now = Date.now(), read: (path: string) => OppRecord[] = Funnel.read): GateInput {
  const paper = read(join(dataDir, "opps-paper.jsonl"));
  const micro = read(join(dataDir, "opps-micro.jsonl"));
  const brain = readJsonWithBackup<{ startedAt?: number }>(join(dataDir, "brain-paper.json"))?.value;
  const start = brain?.startedAt ?? paper[0]?.ts;
  const kill = tradingDisabled(dataDir);
  return {
    paper,
    micro,
    paperDays: start ? Math.max(0, (now - start) / DAY_MS) : 0,
    killSwitch: kill.disabled ? (kill.reason ?? "disabled") : null,
    halted: halted(dataDir),
  };
}
