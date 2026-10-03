import { join } from "node:path";
import { Brain } from "./brain.js";
import { loadConfig } from "./config.js";
import { Ledger, startOfUtcMonth } from "./ledger.js";
import { formatVerdict, monthVerdict } from "./sustain.js";

/** `npm run report`: profit, bills verdict, and what the brain has learned. */
const cfg = loadConfig();
const records = new Ledger(join(cfg.dataDir, `trades-${cfg.mode}.jsonl`)).all();
const brain = new Brain(join(cfg.dataDir, `brain-${cfg.mode}.json`), { baseMinProfitBps: cfg.minProfitBps });

const filled = records.filter((r) => r.status === "filled");
const total = records.reduce((s, r) => s + r.netUsd, 0);
console.log(`Mode: ${cfg.mode}`);
console.log(`Trades: ${filled.length} filled, ${records.filter((r) => r.status === "failed").length} failed`);
console.log(`Total net P&L: $${total.toFixed(4)}  (wallet ~ $${(cfg.startingBalanceUsd + total).toFixed(2)})`);
console.log(formatVerdict(monthVerdict(records, startOfUtcMonth(Date.now()), cfg.monthlyCostsUsd)) + " (month to date)");
console.log("\nBrain:\n" + brain.summary());
