import { join } from "node:path";
import { Brain } from "./brain.js";
import { loadConfig } from "./config.js";
import { Ledger, startOfUtcMonth } from "./ledger.js";
import { assessReadiness } from "./readiness.js";
import { formatVerdict, monthVerdict } from "./sustain.js";

/** `npm run report`: profit, bills verdict, what the brain learned, and whether to go live. */
const cfg = loadConfig();
const records = new Ledger(join(cfg.dataDir, `trades-${cfg.mode}.jsonl`)).all();
const brain = new Brain(join(cfg.dataDir, `brain-${cfg.mode}.json`), { baseMinProfitBps: cfg.minProfitBps });

const count = (status: string) => records.filter((r) => r.status === status).length;
const total = records.reduce((s, r) => s + r.netUsd, 0);
console.log(`Mode: ${cfg.mode}`);
console.log(
  `Trades: ${count("filled")} filled, ${count("rejected")} fake gaps (cost nothing), ${count("failed")} failed`,
);
console.log(`Total net P&L: $${total.toFixed(4)}  (wallet ~ $${(cfg.startingBalanceUsd + total).toFixed(2)})`);
console.log(formatVerdict(monthVerdict(records, startOfUtcMonth(Date.now()), cfg.monthlyCostsUsd)) + " (month to date)");

console.log("\nWhat the brain is thinking:");
for (const t of brain.thoughts(cfg.minProfitBps)) console.log(`- ${t}`);
console.log("\nBrain details:\n" + brain.summary());

if (cfg.mode === "paper") {
  const r = assessReadiness(records, brain.state.startedAt, Date.now(), cfg.monthlyCostsUsd);
  console.log(`\nGo live? ${r.verdict.toUpperCase()}\n${r.message}`);
}
