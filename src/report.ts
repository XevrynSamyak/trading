import type { Mode } from "./config.js";
import { STAGES, type OppRecord } from "./funnel.js";
import type { Verdict } from "./gate.js";
import type { LearningStats } from "./stats.js";
import { sizeBucket } from "./stats.js";

/**
 * `npm run report`: what actually happened, with quoted, executable,
 * simulated and realized results kept apart, and an honest go-live verdict.
 */
export interface ReportData {
  modeNow: Mode;
  /** Round trips quoted by scans (all of them, not only candidates). */
  scans: number;
  opps: OppRecord[];
  stats: LearningStats;
  quotedOnlyUsd: number;
  verdict: Verdict;
  risk: { level: "GREEN" | "AMBER" | "RED"; reasons: string[] };
  thoughts: string[];
  billsLine: string;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fmtBps = (x: number | null) => (x === null ? "   n/a" : `${(x / 100).toFixed(2).padStart(6)}%`);
const fmtMs = (x: number | null) => (x === null ? "n/a" : `${Math.round(x)} ms`);
const usd = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(4)}`;
const pct = (num: number, den: number) => (den ? `${((num / den) * 100).toFixed(1)}%` : "n/a");

/** Best key by mean of a value, among groups with at least `min` samples. */
function bestBy<T>(items: T[], key: (x: T) => string, value: (x: T) => number | null, min = 1): string {
  const groups = new Map<string, number[]>();
  for (const it of items) {
    const v = value(it);
    if (v === null) continue;
    const k = key(it);
    groups.set(k, [...(groups.get(k) ?? []), v]);
  }
  let best: [string, number] | null = null;
  for (const [k, vs] of groups) {
    if (vs.length < min) continue;
    const m = vs.reduce((a, b) => a + b, 0) / vs.length;
    if (!best || m > best[1]) best = [k, m];
  }
  return best ? `${best[0]} (${usd(best[1])} avg)` : "n/a";
}

export function renderReport(d: ReportData): string {
  const o = d.opps;
  const reached = (st: string) => o.filter((r) => STAGES.indexOf(r.stage) >= STAGES.indexOf(st as never)).length;
  const real = o.filter((r) => r.mode !== "paper");
  const sims = o.filter((r) => r.simulated);
  const simOk = sims.filter((r) => r.simulated!.ok);
  const landed = real.filter((r) => r.realized?.landed);
  const profitable = landed.filter((r) => r.realized!.netUsd > 0);
  const failed = real.filter((r) => r.result === "failed");
  const submitted = real.filter((r) => STAGES.indexOf(r.stage) >= STAGES.indexOf("submitted"));
  const realized = landed.reduce((s, r) => s + r.realized!.netUsd, 0);

  const quotedBps = o.map((r) => r.quoted.netBps);
  const execBps = o.filter((r) => r.executable).map((r) => r.executable!.netBps);
  const simBps = simOk.map((r) => r.simulated!.netBps);
  const realBps = landed.map((r) => r.realized!.netBps);

  const line = "=".repeat(48);
  const out: string[] = [];
  out.push(line, "            ARBITRAGE BOT REPORT", line, "");
  out.push(`Mode now:                     ${d.modeNow.toUpperCase()}`);
  out.push(`Scanned round trips:          ${d.scans.toLocaleString("en-US")}`);
  out.push(`Candidates acted on:          ${o.length.toLocaleString("en-US")}`);
  out.push(`  still there at re-quote:    ${reached("executable")}  (${pct(reached("executable"), o.length)})`);
  out.push(`  simulated on-chain:         ${sims.length}  (OK: ${simOk.length}, ${pct(simOk.length, sims.length)})`);
  out.push(`Real trades (MICRO/LIVE):     ${submitted.length} sent, ${landed.length} landed, ${profitable.length} profitable, ${failed.length} failed`);
  out.push("");
  out.push(`Realized P&L (real money):    ${usd(realized)}`);
  out.push(`Quoted-only results:          ${usd(d.quotedOnlyUsd)}  (quotes alone; NOT profit)`);
  out.push("");
  out.push("Net edge after all costs       average   median     n");
  const edgeRow = (name: string, xs: number[]) =>
    `  ${name.padEnd(27)} ${fmtBps(avg(xs))}  ${fmtBps(median(xs))}  ${String(xs.length).padStart(4)}`;
  out.push(edgeRow("quoted (not profit)", quotedBps));
  out.push(edgeRow("executable (fresh re-quote)", execBps));
  out.push(edgeRow("simulated on-chain", simBps));
  out.push(edgeRow("realized", realBps));
  out.push("");
  out.push(`Landing rate:                 ${pct(landed.length, submitted.length)}`);
  out.push(`Profitability rate:           ${pct(profitable.length, landed.length)}`);
  out.push("");
  out.push("Latency (median)");
  const lrow = (label: string, v: string) => out.push(`  ${label}`.padEnd(30) + v);
  const opt = (xs: (number | undefined)[]) => median(xs.filter((x): x is number => x !== undefined));
  lrow("quote (all legs):", fmtMs(median(o.map((r) => r.lat.quoteMs))));
  lrow("market change -> quote:", fmtMs(opt(o.map((r) => r.lat.marketToQuoteMs))));
  lrow("quote -> decision+sizing:", fmtMs(median(o.map((r) => r.lat.quoteToDecisionMs))));
  lrow("decision -> fresh re-quote:", fmtMs(opt(o.map((r) => (r.t.requoteEnd !== undefined ? r.t.requoteEnd - r.t.decision : undefined)))));
  lrow("decision -> submission:", fmtMs(opt(real.map((r) => r.lat.decisionToSubmitMs))));
  lrow("submission -> landing:", fmtMs(opt(real.map((r) => r.lat.submitToLandingMs))));
  lrow("total (avg / median):", `${fmtMs(avg(o.map((r) => r.lat.totalMs)))} / ${fmtMs(median(o.map((r) => r.lat.totalMs)))}`);
  out.push("");
  // "Best" by real money if there is any, else by on-chain simulation; never by quotes.
  const evidence = landed.length ? landed : simOk;
  const val = (r: OppRecord) => (r.realized?.landed ? r.realized.netUsd : r.simulated?.ok ? r.simulated.netUsd : null);
  const basisNote = landed.length ? "realized" : simOk.length ? "simulated" : "no evidence yet";
  out.push(`Best token (${basisNote}):`.padEnd(30) + bestBy(evidence, (r) => r.symbol, val));
  out.push(`Best route:`.padEnd(30) + bestBy(evidence, (r) => r.route, val));
  out.push(`Best trade size:`.padEnd(30) + bestBy(evidence, (r) => `$${sizeBucket(r.sizeUsd)}`, val));
  const chosen = o.filter((r) => r.ladder?.length).map((r) => r.sizeUsd);
  if (chosen.length) out.push(`Size chosen by the ladder:    median $${median(chosen)!.toFixed(2)} (max $${Math.max(...chosen).toFixed(2)})`);
  out.push("");

  const rows = d.stats.table();
  if (rows.length) {
    out.push("Token        n   Quote edge   Exec edge   Real edge   Success");
    for (const r of rows.slice(0, 12)) {
      out.push(
        `${r.symbol.padEnd(10)} ${String(r.n).padStart(4)} ${fmtBps(r.quotedBps).padStart(11)} ${fmtBps(r.execBps).padStart(11)} ` +
          `${fmtBps(r.realBps).padStart(11)}${r.realKind === "simulated" ? "*" : " "} ${r.successPct.toFixed(0).padStart(6)}%`,
      );
    }
    out.push("  (* = simulated on-chain, no real trades yet)");
    out.push("");
  }

  out.push(line);
  out.push(`RISK STATUS:                  ${d.risk.level}`);
  for (const r of d.risk.reasons) out.push(`    - ${r}`);
  out.push("");
  out.push("GO-LIVE VERDICT:");
  out.push(`    MICRO LIVE: ${d.verdict.micro.ok ? "YES" : "NO"}`);
  out.push(`    FULL LIVE:  ${d.verdict.live.ok ? "YES" : "NO"}`);
  out.push("");
  out.push("REASON:");
  const reasons = [...d.verdict.micro.reasons.map((r) => `MICRO: ${r}`), ...d.verdict.live.reasons.map((r) => `LIVE: ${r}`)];
  if (!reasons.length) out.push("    All gates passed on real execution data.");
  for (const r of reasons) out.push(`    ${r}`);
  out.push(line);
  out.push("");
  out.push(d.billsLine);
  if (d.thoughts.length) {
    out.push("", "What the brain is thinking:");
    for (const t of d.thoughts.slice(0, 5)) out.push(`- ${t}`);
  }
  return out.join("\n");
}

/** GREEN / AMBER / RED from what the files say. */
export function riskStatus(a: {
  killSwitch: string | null;
  halted: string | null;
  todayMoneyPnlUsd: number;
  dailyLossLimitUsd: number;
  timeoutsToday: number;
  walletValueUsd?: number;
  lossFloorUsd: number;
}): { level: "GREEN" | "AMBER" | "RED"; reasons: string[] } {
  const red: string[] = [];
  const amber: string[] = [];
  if (a.killSwitch) red.push(`trading disabled: ${a.killSwitch}`);
  if (a.halted) red.push(`halted: ${a.halted}`);
  if (a.todayMoneyPnlUsd <= -0.5 * a.dailyLossLimitUsd) amber.push(`today's P&L $${a.todayMoneyPnlUsd.toFixed(2)} is past half the daily limit`);
  if (a.timeoutsToday) amber.push(`${a.timeoutsToday} unconfirmed landing(s) today`);
  if (a.walletValueUsd !== undefined && a.walletValueUsd <= a.lossFloorUsd * 1.1) amber.push("wallet is within 10% of the loss floor");
  if (red.length) return { level: "RED", reasons: [...red, ...amber] };
  if (amber.length) return { level: "AMBER", reasons: amber };
  return { level: "GREEN", reasons: [] };
}
