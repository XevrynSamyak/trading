import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { Brain, EDGE_BINS } from "./brain.js";
import { loadConfig } from "./config.js";
import { Ledger, startOfUtcDay, type TradeRecord } from "./ledger.js";
import { assessReadiness } from "./readiness.js";
import { readStatus, type LiveStatus } from "./status-file.js";

/**
 * `npm run status`        one-time progress screen
 * `npm run watch`         same, refreshing every few seconds (Ctrl+C to exit)
 */

const TEST_DAYS_TARGET = 3;
const DAY_MS = 86_400_000;
const EVENT_PATTERN =
  /FILLED|REJECTED|FAILED|moving fast|found new tokens|HALTED|paused|Started|Stopped|cycle error|too many requests|crashed|stopped|quote-only/;

export interface StatusInput {
  now: number;
  live: LiveStatus | null;
  processAlive: boolean;
  halted: string | null;
  records: TradeRecord[];
  brainStartedAt: number;
  edgeHistogram: Record<string, number>;
  thoughts: string[];
  events: string[];
  monthlyCosts: Record<string, number>;
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
        : live.onChainTesting
          ? "paper, tested on-chain"
          : "paper, quote-only";
    out.push(`Status:  ${green("● RUNNING")}  (${how})  up ${duration(i.now - live.startedAt)}, ${live.cycles} scans`);
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
      out.push(
        `Speed:   ${live.scansLastMin} scans in the last minute  ` +
          dim(`(Jupiter: ${live.jupiterUsed ?? 0}/${live.jupiterLimit} requests used per minute)`),
      );
    } else if (live.paceFloorMs) {
      out.push(`Speed:   ~${(60_000 / live.paceFloorMs).toFixed(1)} scans/min`);
    }
    if (live.focus?.length) {
      out.push(`Focus:   ${yellow(live.focus.join(", "))} ${dim("(re-checking just this every few seconds)")}`);
    }
    if (live.hot.length) out.push(`Hot:     ${yellow(live.hot.join(", "))} ${dim("(sudden price moves)")}`);
    out.push(
      `Wallet:  $${live.walletValueUsd.toFixed(2)}${live.mode === "paper" ? dim(" (paper)") : ""}   ` +
        `trade size up to $${live.tradeSizeUsd.toFixed(2)}   SOL $${live.solPrice.toFixed(2)}`,
    );
  }

  // --- test progress and verdict -------------------------------------------
  if (!live || live.mode === "paper") {
    const days = (i.now - i.brainStartedAt) / DAY_MS;
    out.push("");
    out.push(
      `Test:    [${bar(days / TEST_DAYS_TARGET, 20)}] ${Math.min(days, 99).toFixed(1)} / ${TEST_DAYS_TARGET} days`,
    );
    const r = assessReadiness(i.records, i.brainStartedAt, i.now, i.monthlyCosts);
    const v = r.verdict.toUpperCase();
    const colored = r.verdict === "try-live" ? green(v) : r.verdict === "keep-testing" ? yellow(v) : red(v);
    out.push(`Go live? ${colored}  ${dim(r.message)}`);
  }

  // --- results --------------------------------------------------------------
  const today = i.records.filter((r) => r.ts >= startOfUtcDay(i.now));
  const count = (rs: TradeRecord[], st: string) => rs.filter((r) => r.status === st).length;
  const sum = (rs: TradeRecord[]) => rs.reduce((s, r) => s + r.netUsd, 0);
  out.push("");
  out.push(bold("Results"));
  out.push(`  today: ${count(today, "filled")} trades, ${count(today, "rejected")} fake gaps, ${money(sum(today))}`);
  out.push(
    `  total: ${count(i.records, "filled")} trades, ${count(i.records, "rejected")} fake gaps, ` +
      `${count(i.records, "failed")} failed, ${money(sum(i.records))}`,
  );

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

/** Last lines of a possibly large log file, reading only its end. */
export function tailLines(path: string, maxLines: number, maxBytes = 64 * 1024): string[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf8").split("\n").filter(Boolean).slice(-maxLines);
}

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function gather(): StatusInput {
  const cfg = loadConfig();
  const live = readStatus(join(cfg.dataDir, "status.json"));
  const brain = new Brain(join(cfg.dataDir, `brain-${cfg.mode}.json`), { baseMinProfitBps: cfg.minProfitBps });
  const haltPath = join(cfg.dataDir, "HALTED");
  return {
    now: Date.now(),
    live,
    processAlive: isAlive(live?.pid),
    halted: existsSync(haltPath) ? readFileSync(haltPath, "utf8").trim() : null,
    records: new Ledger(join(cfg.dataDir, `trades-${cfg.mode}.jsonl`)).all(),
    brainStartedAt: brain.state.startedAt,
    edgeHistogram: brain.state.edgeHistogram,
    thoughts: brain.thoughts(cfg.minProfitBps),
    events: tailLines(join(cfg.dataDir, "bot.log"), 400)
      .filter((l) => EVENT_PATTERN.test(l))
      .slice(-6),
    monthlyCosts: cfg.monthlyCostsUsd,
    color: process.stdout.isTTY ?? false,
  };
}

if (process.argv[1]?.endsWith("status.ts")) {
  if (process.argv.includes("--watch")) {
    const draw = () => {
      // Clear the screen and redraw in place.
      process.stdout.write("\x1b[2J\x1b[H" + renderStatus(gather()) + "\n\n(refreshes every 5s, Ctrl+C to exit)\n");
    };
    draw();
    setInterval(draw, 5_000);
  } else {
    console.log(renderStatus(gather()));
  }
}
