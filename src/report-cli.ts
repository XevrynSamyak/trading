import { join } from "node:path";
import { Brain } from "./brain.js";
import { loadConfig } from "./config.js";
import { Ledger, basisOf, moneyBasis, startOfUtcMonth, totalsByBasis } from "./ledger.js";
import { assessReadiness } from "./readiness.js";
import { formatVerdict, monthVerdict } from "./sustain.js";

/** `npm run report`: profit, bills verdict, what the brain learned, and whether to go live. */
const cfg = loadConfig();
const records = new Ledger(join(cfg.dataDir, `trades-${cfg.mode}.jsonl`)).all();
const brain = new Brain(join(cfg.dataDir, `brain-${cfg.mode}.json`), { baseMinProfitBps: cfg.minProfitBps });

const count = (status: string) => records.filter((r) => r.status === status).length;
const money = moneyBasis(cfg.mode);
const moneyRecords = records.filter((r) => basisOf(r) === money);
const t = totalsByBasis(records);
const usd = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(4)}`;
console.log(`Mode: ${cfg.mode}`);
console.log(`Trades: ${count("filled")} filled, ${count("rejected")} fake gaps (cost nothing), ${count("failed")} failed`);
console.log(`  quoted (NOT profit, quotes only):   ${t.quoted.count} attempts, ${usd(t.quoted.netUsd)}`);
console.log(`  simulated on-chain (nothing sent):  ${t.simulated.count} attempts, ${usd(t.simulated.netUsd)}`);
console.log(`  realized (real money):              ${t.realized.count} attempts, ${usd(t.realized.netUsd)}`);
const moneyNet = t[money].netUsd;
console.log(`Counted P&L (${money} only): ${usd(moneyNet)}  (wallet ~ $${(cfg.startingBalanceUsd + moneyNet).toFixed(2)})`);
console.log(
  formatVerdict(monthVerdict(moneyRecords, startOfUtcMonth(Date.now()), cfg.monthlyCostsUsd)) + ` (month to date, ${money})`,
);

console.log("\nWhat the brain is thinking:");
for (const t of brain.thoughts(cfg.minProfitBps)) console.log(`- ${t}`);
console.log("\nBrain details:\n" + brain.summary());

if (cfg.mode === "paper") {
  const r = assessReadiness(records, brain.state.startedAt, Date.now(), cfg.monthlyCostsUsd);
  console.log(`\nGo live? ${r.verdict.toUpperCase()}\n${r.message}`);
}
