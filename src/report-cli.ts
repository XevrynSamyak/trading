import { join } from "node:path";
import { readJsonWithBackup } from "./atomic.js";
import { Brain } from "./brain.js";
import { loadConfig, safetyThresholds, type Config, type Mode } from "./config.js";
import { gateThresholds, goLiveVerdict, loadGateInput } from "./gate.js";
import { Funnel } from "./funnel.js";
import { Ledger, basisOf, moneyBasis, startOfUtcDay, startOfUtcMonth, totalsByBasis } from "./ledger.js";
import { renderReport, riskStatus, type ReportData } from "./report.js";
import { LearningStats } from "./stats.js";
import { readStatus } from "./status-file.js";
import { formatVerdict, monthVerdict } from "./sustain.js";
import { TokenSafety } from "./tokensafety.js";

/**
 * `npm run report`: quoted, executable, simulated and realized results kept
 * apart, across every mode the bot has run in, plus risk status and an
 * honest go-live verdict.
 */
const MODES: Mode[] = ["paper", "micro", "live"];

export function buildReportData(cfg: Config, now = Date.now()): ReportData & { brainSummary: string } {
  const file = (name: string) => join(cfg.dataDir, name);
  const opps = MODES.flatMap((m) => Funnel.read(file(`opps-${m}.jsonl`)));
  const trades = MODES.flatMap((m) => Ledger.read(file(`trades-${m}.jsonl`)));
  const scans = MODES.reduce(
    (s, m) => s + (readJsonWithBackup<{ totalScans?: number }>(file(`brain-${m}.json`))?.value?.totalScans ?? 0),
    0,
  );
  const gate = loadGateInput(cfg.dataDir, now);
  const verdict = goLiveVerdict(gate, gateThresholds(cfg));

  // Money that counts in the current mode: simulated in paper, realized in micro/live.
  const money = moneyBasis(cfg.mode);
  const mine = trades.filter((r) => r.mode === cfg.mode && basisOf(r) === money);
  const today = startOfUtcDay(now);
  const todayPnl = mine.filter((r) => r.ts >= today).reduce((s, r) => s + r.netUsd, 0);
  const live = readStatus(file("status.json"));
  const risk = riskStatus({
    killSwitch: gate.killSwitch,
    halted: gate.halted,
    todayMoneyPnlUsd: todayPnl,
    dailyLossLimitUsd: cfg.dailyLossLimitUsd,
    timeoutsToday: opps.filter((o) => o.ts >= today && o.result === "timeout").length,
    walletValueUsd: live?.mode === cfg.mode ? live.walletValueUsd : undefined,
    lossFloorUsd: cfg.lossFloorUsd,
  });

  const bills = formatVerdict(monthVerdict(mine, startOfUtcMonth(now), cfg.monthlyCostsUsd));
  const billsLine =
    `Bills: ${bills} (month to date, ` +
    (money === "realized" ? "real money)" : "simulated on-chain only; NOT real money)");

  const brain = new Brain(file(`brain-${cfg.mode}.json`), { baseMinProfitBps: cfg.minProfitBps });
  const safety = new TokenSafety(file("token-safety.json"), { liveTokens: cfg.liveTokens, thresholds: safetyThresholds(cfg) });
  return {
    modeNow: cfg.mode,
    scans,
    opps,
    stats: LearningStats.fromRecords(opps),
    quotedOnlyUsd: totalsByBasis(trades).quoted.netUsd,
    verdict,
    risk,
    thoughts: brain.thoughts(cfg.minProfitBps),
    billsLine,
    safety: Object.entries(brain.tokenPool(cfg.tokens)).map(([symbol, mint]) => ({
      symbol,
      ...safety.verdict(symbol, mint, symbol in cfg.tokens, now),
    })),
    brainSummary: brain.summary(),
  };
}

if (process.argv[1]?.endsWith("report-cli.ts")) {
  const data = buildReportData(loadConfig());
  console.log(renderReport(data));
  console.log("\nBrain details:\n" + data.brainSummary);
}
