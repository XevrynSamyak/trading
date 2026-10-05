import { tailLines } from "./tail.js";
import { join } from "node:path";
import { Brain, EDGE_BINS } from "./brain.js";
import { loadConfig, type Config } from "./config.js";
import { FunnelReader } from "./funnel.js";
import { gateThresholds, goLiveVerdict, loadGateInput, type Verdict } from "./gate.js";
import { halted, tradingDisabled } from "./killswitch.js";
import { Ledger, startOfUtcDay, totalsByBasis, type Basis, type BasisTotals, type TradeRecord } from "./ledger.js";
import { isAlive, readStatus, type LiveStatus } from "./status-file.js";

/**
 * `npm run status`        one-time progress screen
 * `npm run watch`         same, refreshing every few seconds (Ctrl+C to exit)
 */

const DAY_MS = 86_400_000;
const EVENT_PATTERN =
  /FILLED|REJECTED|FAILED|TIMEOUT|DISABLED|re-enabled|moving fast|found new tokens|HALTED|paused|Started|Stopped|cycle error|too many requests|crashed|stopped|refused|quote-only/;

/** Results per basis, today and all time: quoted, simulated and realized are never added together. */
export interface StatusResults {
  today: Record<Basis, BasisTotals>;
  all: Record<Basis, BasisTotals>;
  failed: number;
  fake: number;
}

export function resultsOf(records: TradeRecord[], now: number): StatusResults {
  return {
    today: totalsByBasis(records, startOfUtcDay(now)),
    all: totalsByBasis(records),
    failed: records.filter((r) => r.status === "failed").length,
    fake: records.filter((r) => r.status === "rejected").length,
  };
}

/** Everything the status screen shows. Plain JSON, so a remote dashboard can show it too. */
export interface StatusData {
  live: LiveStatus | null;
  processAlive: boolean;
  halted: string | null;
  /** Kill switch reason while data/TRADING_DISABLED exists. */
  killSwitch: string | null;
  results: StatusResults;
  brainStartedAt: number;
  /** Days of paper testing the go-live gate wants. */
  paperDaysTarget: number;
  /** Go-live gate verdict from paper and MICRO results. */
  verdict: Verdict | null;
  edgeHistogram: Record<string, number>;
  thoughts: string[];
  events: string[];
}

export interface StatusInput extends StatusData {
  now: number;
  color: boolean;
}

export function bar(fraction: number, width: number): string {
  const f = Math.min(1, Math.max(0, fraction));
  const full = Math.round(f * width);
  return "█".repeat(full) + "░".repeat(width - full);
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

const money = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(4)}`;

export function renderStatus(i: StatusInput): string {
  const c = (code: number, t: string) => (i.color ? `\x1b[${code}m${t}\x1b[0m` : t);
  const green = (t: string) => c(32, t);
  const red = (t: string) => c(31, t);
  const yellow = (t: string) => c(33, t);
  const dim = (t: string) => c(2, t);
  const bold = (t: string) => c(1, t);
  const out: string[] = [];
  const live = i.live;

  out.push(bold(`=== Solana arb bot ===  `) + dim(new Date(i.now).toISOString().slice(0, 16).replace("T", " ") + " UTC"));

  // --- is it running? -------------------------------------------------------
  const staleAfter = Math.max(120_000, (live?.nextScanInMs ?? 0) * 2 + 30_000);
  const age = live ? i.now - live.updatedAt : Infinity;
  if (i.halted) {
    out.push(`Status:  ${red("■ HALTED")}  ${i.halted}`);
    out.push(dim("         Read the reason, then delete data/HALTED to allow a restart."));
  } else if (!live) {
    out.push(`Status:  ${yellow("○ NOT STARTED YET")}  start it: bash deploy/termux-run.sh &`);
  } else if (!i.processAlive || live.state === "stopped") {
    out.push(`Status:  ${red("■ STOPPED")}  (last seen ${duration(age)} ago)  start it: bash deploy/termux-run.sh &`);
  } else if (age > staleAfter) {
    out.push(`Status:  ${yellow("● STUCK?")}  running but no update for ${duration(age)}; check: tail data/bot.log`);
  } else {
    const how =
      live.mode === "live"
        ? `LIVE, real money via ${live.sendVia}`
        : live.mode === "micro"
          ? `MICRO, tiny real trades via ${live.sendVia}`
          : live.onChainTesting
            ? "paper, tested on-chain"
            : "paper, quote-only";
    out.push(`Status:  ${green("● RUNNING")}  (${how})  up ${duration(i.now - live.startedAt)}, ${live.cycles} scans`);
  }
  if (i.killSwitch && !i.halted) {
    out.push(`Trading: ${red("■ DISABLED")}  ${i.killSwitch}`);
    out.push(dim("         Check why, then re-enable: npm run enable-trading"));
  }

  if (live && i.processAlive && !i.halted) {
    const next = Math.max(0, live.updatedAt + live.nextScanInMs - i.now);
    const doing =
      live.state === "scanning" ? `scanning, next scan in ${duration(next)}` : `${live.state}: ${live.note ?? ""}`;
    out.push(`Doing:   ${doing}`);
    if (live.state === "scanning" && live.note) out.push(`         ${yellow(live.note)}`);
    if (live.lastBest) {
      const b = live.lastBest;
      // How close the last scan came: -20bps or worse = empty, at the bar = full.
      const closeness = (b.expectedBps + 20) / (b.needBps + 20);
      const exp = Math.abs(b.expectedBps - b.netBps) >= 0.1 ? ` (expect ${b.expectedBps.toFixed(1)})` : "";
      out.push(
        `Last:    ${b.symbol} ${b.netBps.toFixed(1)}bps${exp}, need ${b.needBps}  ` +
          `${closeness >= 1 ? green(bar(1, 12)) : bar(closeness, 12)} ${dim("how close")}`,
      );
    }
    if (live.scansLastMin !== undefined && live.jupiterLimit) {
      const upMs = i.now - live.startedAt;
      const scans =
        upMs < 60_000
          ? `${live.scansLastMin} scans so far (started ${duration(upMs)} ago)`
          : `${live.scansLastMin} scans in the last minute`;
      out.push(`Speed:   ${scans}  ` + dim(`(Jupiter: ${live.jupiterUsed ?? 0}/${live.jupiterLimit} requests used per minute)`));
      if (live.quoteMs !== undefined) out.push(dim(`         quoting both legs of a token takes ~${live.quoteMs} ms from here`));
    } else if (live.paceFloorMs) {
      out.push(`Speed:   ~${(60_000 / live.paceFloorMs).toFixed(1)} scans/min`);
    }
    if (live.events) {
      const e = live.events;
      out.push(
        `Events:  ${e.capped ? yellow("paused for today (daily cap reached)") : `watching ${e.watching} pool(s)`}, ` +
          `${e.eventsToday.toLocaleString("en-US")} / ${e.cap.toLocaleString("en-US")} updates today` +
          (e.tooBusy ? dim(`  (${e.tooBusy} too-busy pool(s) resting)`) : ""),
      );
    }
    if (live.focus?.length) {
      out.push(`Focus:   ${yellow(live.focus.join(", "))} ${dim("(re-checking just this every few seconds)")}`);
    }
    if (live.funnelToday && Object.keys(live.funnelToday).length) {
      const f = live.funnelToday;
      out.push(
        `Funnel:  ${["quoted", "executable", "simulated", "submitted", "landed", "profitable"]
          .map((s) => `${s} ${f[s] ?? 0}`)
          .join(" → ")} ${dim("(today)")}`,
      );
    }
    if (live.lastOpp) {
      const o = live.lastOpp;
      out.push(
        `Latest:  ${o.id} ${o.symbol} quoted ${o.quotedBps.toFixed(1)}bps` +
          (o.execBps !== undefined ? ` → fresh ${o.execBps.toFixed(1)}bps` : "") +
          ` → ${o.result} at "${o.stage}" ${dim(`(${o.totalMs} ms)`)}`,
      );
    }
    if (live.hot.length) out.push(`Hot:     ${yellow(live.hot.join(", "))} ${dim("(sudden price moves)")}`);
    out.push(
      `Wallet:  $${live.walletValueUsd.toFixed(2)}${live.mode === "paper" ? dim(" (paper)") : ""}   ` +
        `trade size up to $${live.tradeSizeUsd.toFixed(2)}   SOL $${live.solPrice.toFixed(2)}`,
    );
  }

  // --- test progress and the go-live gate -----------------------------------
  const paper = !live || live.mode === "paper";
  if (paper || i.verdict) out.push("");
  if (paper) {
    const days = (i.now - i.brainStartedAt) / DAY_MS;
    out.push(
      `Test:    [${bar(days / i.paperDaysTarget, 20)}] ${Math.min(days, 99).toFixed(1)} / ${i.paperDaysTarget} days`,
    );
  }
  if (i.verdict) {
    const v = i.verdict;
    const yn = (ok: boolean) => (ok ? green("YES") : red("NO"));
    out.push(`Go live? MICRO: ${yn(v.micro.ok)}  LIVE: ${yn(v.live.ok)}  ${dim("(npm run report explains)")}`);
    // The next hurdle: MICRO's while paper testing, LIVE's once real trades run.
    const why = (paper ? v.micro.reasons : v.live.reasons)[0];
    if (why) out.push(dim(`         ${why}`));
  }

  // --- results: quoted, simulated and realized are NEVER added together ------
  const { all: allT, today: todayT, failed, fake } = i.results;
  out.push("");
  out.push(bold("Results") + dim("  (today / all time)"));
  const row = (name: string, b: Basis, note: string) =>
    `  ${name.padEnd(22)} ${String(todayT[b].count).padStart(3)} / ${String(allT[b].count).padEnd(4)} ` +
    `${money(todayT[b].netUsd)} / ${money(allT[b].netUsd)}  ${dim(note)}`;
  out.push(yellow(row("quoted (not profit)", "quoted", "quotes only, unproven")));
  out.push(row("simulated on-chain", "simulated", "exact tx simulated, nothing sent"));
  out.push(row("realized (real money)", "realized", "landed transactions"));
  out.push(`  fake gaps (cost nothing): ${fake}   failed on-chain: ${failed}`);

  // --- how close gaps got ---------------------------------------------------
  const total = Object.values(i.edgeHistogram).reduce((a, b) => a + b, 0);
  if (total) {
    out.push("");
    out.push(bold("How close gaps got") + dim(" (best per scan, bps after fees)"));
    for (const [label] of EDGE_BINS) {
      const n = i.edgeHistogram[label] ?? 0;
      if (!n) continue;
      const pct = n / total;
      const line = `  ${label.padEnd(8)} ${bar(pct, 20)} ${(pct * 100).toFixed(1)}%`;
      out.push(label === "20+" || label === "10..20" ? green(line) : line);
    }
  }

  if (i.thoughts.length) {
    out.push("");
    out.push(bold("Brain thinks"));
    for (const t of i.thoughts.slice(0, 4)) out.push(`  - ${t}`);
  }

  if (i.events.length) {
    out.push("");
    out.push(bold("Recent events"));
    for (const e of i.events) out.push(dim(`  ${e.slice(0, 160)}`));
  }

  return out.join("\n");
}

export { tailLines } from "./tail.js";


// Funnel files only grow; when refreshing, parse just the new lines.
const readers = new Map<string, FunnelReader>();
const readCached = (path: string) => {
  let r = readers.get(path);
  if (!r) readers.set(path, (r = new FunnelReader(path)));
  return r.read();
};

/** Reads the data folder. The engine's status server calls this too. */
export function gatherStatus(cfg: Config, now = Date.now()): StatusData {
  const live = readStatus(join(cfg.dataDir, "status.json"));
  const brain = new Brain(join(cfg.dataDir, `brain-${cfg.mode}.json`), { baseMinProfitBps: cfg.minProfitBps });
  const kill = tradingDisabled(cfg.dataDir);
  let verdict: Verdict | null = null;
  try {
    verdict = goLiveVerdict(loadGateInput(cfg.dataDir, now, readCached), gateThresholds(cfg));
  } catch {
    // The verdict is a hint on this screen; `npm run report` shows any problem.
  }
  return {
    live,
    processAlive: isAlive(live?.pid),
    halted: halted(cfg.dataDir),
    killSwitch: kill.disabled ? (kill.reason ?? "disabled") : null,
    results: resultsOf(Ledger.read(join(cfg.dataDir, `trades-${cfg.mode}.jsonl`)), now),
    brainStartedAt: brain.state.startedAt,
    paperDaysTarget: cfg.gateMinPaperDays,
    verdict,
    edgeHistogram: brain.state.edgeHistogram,
    thoughts: brain.thoughts(cfg.minProfitBps),
    events: tailLines(join(cfg.dataDir, "bot.log"), 400)
      .filter((l) => EVENT_PATTERN.test(l))
      .slice(-6),
  };
}

/** A remote engine's status (ENGINE_URL), e.g. the phone's, seen from a laptop. */
export async function fetchRemoteStatus(engineUrl: string, token: string | undefined, fetchFn: typeof fetch = fetch): Promise<StatusData> {
  const res = await fetchFn(`${engineUrl.replace(/\/$/, "")}/status.json`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`engine answered ${res.status}${res.status === 401 ? " (check ENGINE_TOKEN)" : ""}`);
  return (await res.json()) as StatusData;
}

async function screen(): Promise<string> {
  const color = process.stdout.isTTY ?? false;
  const engine = process.env.ENGINE_URL;
  if (!engine) return renderStatus({ ...gatherStatus(loadConfig()), now: Date.now(), color });
  try {
    const data = await fetchRemoteStatus(engine, process.env.ENGINE_TOKEN || process.env.STATUS_HTTP_TOKEN);
    return renderStatus({ ...data, now: Date.now(), color }) + `\n\n(from ${engine})`;
  } catch (err) {
    return `Cannot reach the bot at ${engine}: ${String(err instanceof Error ? err.message : err).slice(0, 160)}`;
  }
}

if (process.argv[1]?.endsWith("status.ts")) {
  if (process.argv.includes("--watch")) {
    const draw = async () => {
      // Clear the screen and redraw in place.
      process.stdout.write("\x1b[2J\x1b[H" + (await screen()) + "\n\n(refreshes every 5s, Ctrl+C to exit)\n");
    };
    void draw();
    setInterval(() => void draw(), 5_000);
  } else {
    void screen().then((text) => console.log(text));
  }
}
