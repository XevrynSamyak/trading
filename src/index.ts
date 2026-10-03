import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, type Keypair } from "@solana/web3.js";
import { Brain } from "./brain.js";
import { loadConfig, tradeSizeUsd } from "./config.js";
import { liveExecute, paperExecute, type ExecResult } from "./executor.js";
import { JupiterClient } from "./jupiter.js";
import { Ledger, startOfUtcDay, startOfUtcMonth } from "./ledger.js";
import { makeNotifier } from "./notify.js";
import { usdToUsdcAtoms } from "./profit.js";
import { RiskManager } from "./risk.js";
import { fetchSolPriceUsd, scan } from "./scanner.js";
import { formatVerdict, monthVerdict, shouldRetire } from "./sustain.js";
import { getBalances, loadKeypair, walletValueUsd } from "./wallet.js";

const SOL_PRICE_REFRESH_MS = 5 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = loadConfig();
  const notify = makeNotifier(cfg);
  const haltFile = join(cfg.dataDir, "HALTED");
  if (existsSync(haltFile)) {
    console.error(`Bot is halted (${haltFile}). Read it, then delete it to restart.`);
    process.exit(1);
  }

  const jup = new JupiterClient(cfg.jupiterApi);
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const wallet: Keypair | undefined = cfg.walletSecretKey ? loadKeypair(cfg.walletSecretKey) : undefined;
  const ledger = new Ledger(join(cfg.dataDir, `trades-${cfg.mode}.jsonl`));
  const brain = new Brain(join(cfg.dataDir, `brain-${cfg.mode}.json`), { baseMinProfitBps: cfg.minProfitBps });
  const risk = new RiskManager(cfg);

  const halt = async (reason: string) => {
    writeFileSync(haltFile, `${new Date().toISOString()} ${reason}\n`);
    await notify(`HALTED: ${reason}. Remaining funds stay in the wallet.`);
    brain.save();
    process.exit(0);
  };

  let running = true;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      running = false;
    });
  }

  let solPrice = await fetchSolPriceUsd(jup);
  let solPriceAt = Date.now();
  let lastDay = startOfUtcDay(Date.now());
  let lastMonth = startOfUtcMonth(Date.now());

  await notify(
    `Started in ${cfg.mode.toUpperCase()} mode` +
      (wallet ? ` with wallet ${wallet.publicKey.toBase58()}` : "") +
      `. Loss floor $${cfg.lossFloorUsd}, no profit cap. SOL=$${solPrice.toFixed(2)}`,
  );

  while (running) {
    const now = Date.now();
    try {
      if (now - solPriceAt > SOL_PRICE_REFRESH_MS) {
        solPrice = await fetchSolPriceUsd(jup);
        solPriceAt = now;
      }

      const records = ledger.all();

      // Daily and monthly bookkeeping.
      if (startOfUtcDay(now) !== lastDay) {
        const pnl = ledger.pnlBetween(lastDay, startOfUtcDay(now), records);
        await notify(`Daily: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}\n${brain.summary()}`);
        lastDay = startOfUtcDay(now);
      }
      if (startOfUtcMonth(now) !== lastMonth) {
        await notify(formatVerdict(monthVerdict(records, lastMonth, cfg.monthlyCostsUsd)));
        lastMonth = startOfUtcMonth(now);
        if (shouldRetire(records, now, cfg.monthlyCostsUsd, cfg.sustainStopAfterMonths, records[0]?.ts)) {
          await halt(`did not cover its bills for ${cfg.sustainStopAfterMonths} months in a row`);
        }
      }

      // Current wallet value (real on-chain in live mode, simulated in paper mode).
      let valueUsd: number;
      let usdcUsd: number;
      if (cfg.mode === "live" && wallet) {
        const b = await getBalances(conn, wallet.publicKey);
        valueUsd = walletValueUsd(b, solPrice);
        usdcUsd = Number(b.usdcAtoms) / 1e6;
      } else {
        valueUsd = cfg.startingBalanceUsd + records.reduce((s, r) => s + r.netUsd, 0);
        usdcUsd = valueUsd;
      }

      const decision = risk.check(valueUsd, ledger.pnlBetween(startOfUtcDay(now), undefined, records), now);
      if (!decision.ok) {
        if (decision.halt) await halt(decision.reason);
        console.log(`paused: ${decision.reason}`);
        await sleep(cfg.scanIntervalMs * 4);
        continue;
      }

      const sizeUsd = tradeSizeUsd(cfg, usdcUsd);
      if (sizeUsd < 1) {
        console.log(`only $${usdcUsd.toFixed(2)} USDC available; waiting`);
        await sleep(cfg.scanIntervalMs * 4);
        continue;
      }

      const tokens = brain.pickTokens(cfg.tokens);
      const opps = await scan(jup, tokens, usdToUsdcAtoms(sizeUsd), cfg.priorityFeeLamports, solPrice, (sym, err) =>
        console.warn(`quote ${sym} failed: ${String(err).slice(0, 120)}`),
      );
      for (const o of opps) brain.observeScan(o.symbol, o.eval.netBps);

      const best = opps[0];
      if (best) {
        console.log(
          `best ${best.symbol} $${sizeUsd}: net ${best.eval.netBps.toFixed(1)}bps ($${best.eval.netUsd.toFixed(4)}) ` +
            `need ${brain.minProfitBps}bps [${best.routes}]`,
        );
      }

      if (best && best.eval.netBps >= brain.minProfitBps) {
        const result: ExecResult =
          cfg.mode === "live" && wallet ? await liveExecute(best, { conn, jup, wallet, cfg }) : paperExecute(best);
        ledger.append({
          ts: Date.now(),
          mode: cfg.mode,
          symbol: best.symbol,
          status: result.status,
          inUsd: sizeUsd,
          netUsd: result.netUsd,
          feeUsd: result.feeUsd,
          signature: result.signature,
          reason: result.reason,
        });
        brain.observeTrade(best.symbol, result.status, result.netUsd);
        risk.recordResult(result.status);
        if (result.status !== "skipped") {
          await notify(
            `${result.status.toUpperCase()} ${best.symbol} $${sizeUsd}: net $${result.netUsd.toFixed(4)}` +
              (result.signature ? ` https://solscan.io/tx/${result.signature}` : "") +
              (result.reason ? ` (${result.reason})` : ""),
          );
        }
      }
      brain.save();
    } catch (err) {
      console.error("cycle error:", err);
    }
    await sleep(cfg.scanIntervalMs);
  }

  brain.save();
  await notify("Stopped.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
