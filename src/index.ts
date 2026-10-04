import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, PublicKey, type Keypair } from "@solana/web3.js";
import { Brain, type SizeBucket } from "./brain.js";
import { extraFeeLamports, loadConfig, tradeSizeUsd } from "./config.js";
import { discoverTokens } from "./discovery.js";
import { liveExecute, paperExecute, simulateExecute, type ExecResult } from "./executor.js";
import { JitoClient } from "./jito.js";
import { JupiterClient } from "./jupiter.js";
import { Ledger, startOfUtcDay, startOfUtcMonth } from "./ledger.js";
import { makeNotifier } from "./notify.js";
import { usdToUsdcAtoms } from "./profit.js";
import { RiskManager } from "./risk.js";
import { fetchSolPriceUsd, scan } from "./scanner.js";
import { formatVerdict, monthVerdict, shouldRetire } from "./sustain.js";
import { getBalances, loadKeypair, walletValueUsd } from "./wallet.js";

const SOL_PRICE_REFRESH_MS = 5 * 60_000;
const DISCOVERY_INTERVAL_MS = 6 * 60 * 60_000;
const TIP_ACCOUNTS_RETRY_MS = 10 * 60_000;
const RATE_LIMIT_BACKOFF_MS = 60_000;
/** On-chain tests need SOL for fees and for opening token accounts (~0.002 SOL each). */
const MIN_SOL_TO_SIMULATE = 0.01;
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
  // Paper mode only needs the public address to test trades on-chain.
  const owner = wallet?.publicKey ?? (cfg.walletPublicKey ? new PublicKey(cfg.walletPublicKey) : undefined);
  const jito = cfg.sendVia === "jito" ? new JitoClient(cfg.jitoUrl) : undefined;
  const ledger = new Ledger(join(cfg.dataDir, `trades-${cfg.mode}.jsonl`));
  const brain = new Brain(join(cfg.dataDir, `brain-${cfg.mode}.json`), { baseMinProfitBps: cfg.minProfitBps });
  const risk = new RiskManager(cfg);
  const extraLamports = extraFeeLamports(cfg);

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

  let tipAccounts: PublicKey[] = [];
  let tipAccountsAt = 0;
  const refreshTipAccounts = async () => {
    // Only needed to build real transactions (live, or on-chain paper testing).
    if (!jito || !owner || tipAccounts.length || Date.now() - tipAccountsAt < TIP_ACCOUNTS_RETRY_MS) return;
    tipAccountsAt = Date.now();
    try {
      tipAccounts = (await jito.getTipAccounts()).map((a) => new PublicKey(a));
    } catch (err) {
      console.warn(`could not load Jito tip accounts (will retry): ${String(err).slice(0, 120)}`);
    }
  };
  const pickTip = () => (tipAccounts.length ? tipAccounts[Math.floor(Math.random() * tipAccounts.length)] : undefined);

  let solPrice = await fetchSolPriceUsd(jup);
  let solPriceAt = Date.now();
  let discoveredAt = 0;
  let lastDay = startOfUtcDay(Date.now());
  let lastMonth = startOfUtcMonth(Date.now());
  let warnedUnfunded = false;

  const how =
    cfg.mode === "live"
      ? `sending via ${cfg.sendVia.toUpperCase()}`
      : owner
        ? "testing each trade on-chain with your wallet's public address (nothing is sent)"
        : "quote-only (add WALLET_PUBLIC_KEY for realistic on-chain testing)";
  await notify(
    `Started in ${cfg.mode.toUpperCase()} mode, ${how}` +
      (owner ? `. Wallet ${owner.toBase58()}` : "") +
      `. Loss floor $${cfg.lossFloorUsd}, no profit cap. SOL=$${solPrice.toFixed(2)}`,
  );

  while (running) {
    const now = Date.now();
    let nextWaitMs = cfg.scanIntervalMs;
    let rateLimited = false;
    try {
      if (cfg.tokenDiscovery && now - discoveredAt > DISCOVERY_INTERVAL_MS) {
        discoveredAt = now;
        try {
          const found = await discoverTokens(cfg.jupiterTokensApi, {
            minLiquidityUsd: cfg.minTokenLiquidityUsd,
            limit: cfg.maxTokens,
          });
          const added = brain.learnTokens(found, cfg.tokens, cfg.maxTokens);
          if (added.length) console.log(`brain found new tokens to watch: ${added.join(", ")}`);
        } catch (err) {
          console.warn(`token discovery failed (keeps current list): ${String(err).slice(0, 120)}`);
        }
      }
      await refreshTipAccounts();

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

      // Wallet value: real on-chain in live mode, simulated P&L in paper mode.
      const paperValue = cfg.startingBalanceUsd + records.reduce((s, r) => s + r.netUsd, 0);
      let valueUsd = paperValue;
      let usdcUsd = paperValue;
      let simulateAs: PublicKey | undefined;
      if (owner) {
        const b = await getBalances(conn, owner);
        const realUsdc = Number(b.usdcAtoms) / 1e6;
        if (cfg.mode === "live") {
          valueUsd = walletValueUsd(b, solPrice);
          usdcUsd = realUsdc;
        } else if (realUsdc >= 1 && b.lamports / 1e9 >= MIN_SOL_TO_SIMULATE) {
          // On-chain simulation can only spend what the wallet really holds.
          usdcUsd = Math.min(paperValue, realUsdc);
          simulateAs = owner;
        } else if (!warnedUnfunded) {
          warnedUnfunded = true;
          console.warn(
            `wallet needs at least $1 USDC and ${MIN_SOL_TO_SIMULATE} SOL to test on-chain; quote-only until funded`,
          );
        }
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

      const tokens = brain.pickTokens(brain.tokenPool(cfg.tokens));
      const buckets: Record<string, SizeBucket> = {};
      const sizeFor = (sym: string) => {
        const pick = brain.pickSize(sym, sizeUsd);
        buckets[sym] = pick.bucket;
        return usdToUsdcAtoms(pick.usd);
      };
      const opps = await scan(jup, tokens, sizeFor, extraLamports, solPrice, (sym, err) => {
        if (String(err).includes(" 429")) rateLimited = true;
        console.warn(`quote ${sym} failed: ${String(err).slice(0, 120)}`);
      });
      for (const o of opps) brain.observeScan(o.symbol, o.eval.netBps, o.eval.netUsd, buckets[o.symbol]);

      const best = opps[0];
      if (best) {
        brain.observeCycle(best.eval.netBps);
        console.log(
          `best ${best.symbol} $${best.eval.inUsd.toFixed(2)}: net ${best.eval.netBps.toFixed(1)}bps ` +
            `($${best.eval.netUsd.toFixed(4)}) need ${brain.minProfitBps}bps [${best.routes}]`,
        );
      }

      if (best && best.eval.netBps >= brain.minProfitBps) {
        const deps = { conn, jup, cfg, solPriceUsd: solPrice, tipAccount: pickTip() };
        let result: ExecResult;
        if (cfg.mode === "live" && wallet) result = await liveExecute(best, wallet, { ...deps, jito });
        else if (simulateAs) result = await simulateExecute(best, simulateAs, deps);
        else result = paperExecute(best);

        ledger.append({
          ts: Date.now(),
          mode: cfg.mode,
          symbol: best.symbol,
          status: result.status,
          inUsd: best.eval.inUsd,
          netUsd: result.netUsd,
          feeUsd: result.feeUsd,
          signature: result.signature,
          reason: result.reason,
          verified: result.verified,
        });
        brain.observeTrade(best.symbol, result.status, result.netUsd);
        risk.recordResult(result.status);

        const line =
          `${result.status.toUpperCase()} ${best.symbol} $${best.eval.inUsd.toFixed(2)}: net $${result.netUsd.toFixed(4)}` +
          (result.signature ? ` https://solscan.io/tx/${result.signature}` : "") +
          (result.reason ? ` (${result.reason})` : "");
        if (result.status === "filled" || result.status === "failed") await notify(line);
        else console.log(line);
      }

      nextWaitMs = brain.nextIntervalMs(best?.eval.netBps, cfg.scanIntervalMs);
      if (rateLimited) {
        nextWaitMs = Math.max(nextWaitMs, RATE_LIMIT_BACKOFF_MS);
        console.warn("Jupiter says too many requests; backing off for a minute");
      }
      brain.save();
    } catch (err) {
      console.error("cycle error:", err);
    }
    await sleep(nextWaitMs);
  }

  brain.save();
  await notify("Stopped.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
