import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, PublicKey, type Keypair } from "@solana/web3.js";
import { Brain, type SizeBucket } from "./brain.js";
import { RequestBudget, budgetedFetch } from "./budget.js";
import {
  TOKENS_PER_SCAN,
  extraFeeLamports,
  jupiterRateWindows,
  loadConfig,
  maxScansPerMin,
  shardTokens,
  tradeSizeUsd,
} from "./config.js";
import { discoverTokens } from "./discovery.js";
import { liveExecute, paperExecute, simulateExecute, type ExecResult } from "./executor.js";
import { JitoClient } from "./jito.js";
import { JupiterClient } from "./jupiter.js";
import { Ledger, startOfUtcDay, startOfUtcMonth } from "./ledger.js";
import { makeNotifier } from "./notify.js";
import { usdToUsdcAtoms } from "./profit.js";
import { RiskManager } from "./risk.js";
import { fetchSolPriceUsd, scan } from "./scanner.js";
import { writeStatus, type LiveStatus } from "./status-file.js";
import { formatVerdict, monthVerdict, shouldRetire } from "./sustain.js";
import { BalanceCache, loadKeypair, walletValueUsd } from "./wallet.js";

const SOL_PRICE_REFRESH_MS = 5 * 60_000;
const DISCOVERY_INTERVAL_MS = 6 * 60 * 60_000;
const TIP_ACCOUNTS_RETRY_MS = 10 * 60_000;
/** Short pause after "too many requests"; the learned pace does the real slowing down. */
const RATE_LIMIT_BACKOFF_MS = 10_000;
/** On-chain tests need SOL for fees and for opening token accounts (~0.002 SOL each). */
const MIN_SOL_TO_SIMULATE = 0.01;
// Sleep that a stop signal can cut short, so stopping the bot is immediate.
let wakeUp: (() => void) | undefined;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    wakeUp = () => {
      clearTimeout(timer);
      resolve();
    };
  });

async function main() {
  const cfg = loadConfig();
  const notify = makeNotifier(cfg);
  const haltFile = join(cfg.dataDir, "HALTED");
  if (existsSync(haltFile)) {
    console.error(`Bot is halted (${haltFile}). Read it, then delete it to restart.`);
    process.exit(1);
  }

  // Every Jupiter request goes through one counter covering a 60s and a 10s window, and the
  // bot waits for room before each request group, so it never bursts over Jupiter's limits.
  const budget = new RequestBudget(jupiterRateWindows(cfg.jupiterRpm));
  const jupFetch = budgetedFetch(budget);
  const jup = new JupiterClient(cfg.jupiterApi, jupFetch, cfg.jupiterApiKey);
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const wallet: Keypair | undefined = cfg.walletSecretKey ? loadKeypair(cfg.walletSecretKey) : undefined;
  // Paper mode only needs the public address to test trades on-chain.
  const owner = wallet?.publicKey ?? (cfg.walletPublicKey ? new PublicKey(cfg.walletPublicKey) : undefined);
  const jito = cfg.sendVia === "jito" ? new JitoClient(cfg.jitoUrl) : undefined;
  const ledger = new Ledger(join(cfg.dataDir, `trades-${cfg.mode}.jsonl`));
  const brain = new Brain(join(cfg.dataDir, `brain-${cfg.mode}.json`), {
    baseMinProfitBps: cfg.minProfitBps,
    minIntervalMs: cfg.minScanIntervalMs,
    minMsPerRequest: cfg.jupiterMsPerRequest,
    tokensPerCycle: TOKENS_PER_SCAN,
  });
  const balanceCache = owner ? new BalanceCache(conn, owner) : undefined;
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
      wakeUp?.();
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

  const waitForJupiter = async (requests: number) => {
    const ms = budget.waitFor(requests);
    if (ms > 0 && running) await sleep(ms);
  };

  let solPrice = await fetchSolPriceUsd(jup);
  let solPriceAt = Date.now();
  let discoveredAt = 0;
  let lastDay = startOfUtcDay(Date.now());
  let lastMonth = startOfUtcMonth(Date.now());
  let warnedUnfunded = false;

  // Live progress for `npm run status`.
  const statusPath = join(cfg.dataDir, "status.json");
  const startedAt = Date.now();
  let cycles = 0;
  const scanTimes: number[] = [];
  const scansInLastMinute = () => {
    while (scanTimes.length && scanTimes[0] <= Date.now() - 60_000) scanTimes.shift();
    return scanTimes.length;
  };
  const status: LiveStatus = {
    pid: process.pid,
    mode: cfg.mode,
    startedAt,
    updatedAt: startedAt,
    cycles: 0,
    state: "scanning",
    onChainTesting: false,
    sendVia: cfg.sendVia,
    solPrice: 0,
    walletValueUsd: cfg.startingBalanceUsd,
    tradeSizeUsd: 0,
    hot: [],
    nextScanInMs: 0,
  };
  const publish = (patch: Partial<LiveStatus>) => {
    Object.assign(status, patch, { updatedAt: Date.now(), cycles, solPrice, hot: brain.hotSymbols() });
    try {
      writeStatus(statusPath, status);
    } catch {
      // Status is only for display; never let it stop trading.
    }
  };

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
  console.log(
    `Jupiter: ${cfg.jupiterApiKey ? "using your API key" : "no API key"} (${cfg.jupiterRpm} requests/min), ` +
      `so up to ~${maxScansPerMin(cfg.jupiterMsPerRequest).toFixed(1)} full scans/min, ` +
      `or ~${maxScansPerMin(cfg.jupiterMsPerRequest, 2).toFixed(0)} focus scans/min on a moving token`,
  );
  if (cfg.shard.count > 1) {
    const mine = Object.keys(shardTokens(cfg.tokens, brain.state.discovered, cfg.shard));
    console.log(
      `Phone ${cfg.shard.index} of ${cfg.shard.count}: watching ${mine.join(", ")} ` +
        `(plus its share of tokens it finds); the other phone(s) watch the rest`,
    );
  }

  while (running) {
    const now = Date.now();
    cycles += 1;
    let nextWaitMs = cfg.scanIntervalMs;
    let rateLimited = false;
    try {
      if (cfg.tokenDiscovery && now - discoveredAt > DISCOVERY_INTERVAL_MS) {
        discoveredAt = now;
        try {
          await waitForJupiter(1);
          const found = await discoverTokens(
            cfg.jupiterTokensApi,
            { minLiquidityUsd: cfg.minTokenLiquidityUsd, limit: cfg.maxTokens },
            jupFetch,
            cfg.jupiterApiKey,
          );
          const added = brain.learnTokens(found, cfg.tokens, cfg.maxTokens);
          if (added.length) console.log(`brain found new tokens to watch: ${added.join(", ")}`);
        } catch (err) {
          console.warn(`token discovery failed (keeps current list): ${String(err).slice(0, 120)}`);
        }
      }
      await refreshTipAccounts();

      if (now - solPriceAt > SOL_PRICE_REFRESH_MS) {
        await waitForJupiter(1);
        solPrice = await fetchSolPriceUsd(jup);
        solPriceAt = now;
      }

      const records = ledger.all();

      // Daily and monthly bookkeeping.
      if (startOfUtcDay(now) !== lastDay) {
        const pnl = ledger.pnlBetween(lastDay, startOfUtcDay(now), records);
        await notify(
          `Daily: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}\n` +
            brain.thoughts(cfg.minProfitBps).map((t) => `- ${t}`).join("\n"),
        );
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
      if (owner && balanceCache) {
        const b = await balanceCache.get();
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
      publish({ walletValueUsd: valueUsd, onChainTesting: cfg.mode === "paper" && !!simulateAs });
      if (!decision.ok) {
        if (decision.halt) await halt(decision.reason);
        publish({ state: "paused", note: decision.reason, nextScanInMs: cfg.scanIntervalMs * 4 });
        console.log(`paused: ${decision.reason}`);
        await sleep(cfg.scanIntervalMs * 4);
        continue;
      }

      const sizeUsd = tradeSizeUsd(cfg, usdcUsd);
      if (sizeUsd < 1) {
        publish({ state: "waiting", note: `only $${usdcUsd.toFixed(2)} USDC available`, nextScanInMs: cfg.scanIntervalMs * 4 });
        console.log(`only $${usdcUsd.toFixed(2)} USDC available; waiting`);
        await sleep(cfg.scanIntervalMs * 4);
        continue;
      }

      // With several phones, each watches its own share of the tokens.
      const pool = shardTokens(cfg.tokens, brain.state.discovered, cfg.shard);
      const tokens = brain.pickTokens(pool);
      scanTimes.push(Date.now());
      const buckets: Record<string, SizeBucket> = {};
      const sizeFor = (sym: string) => {
        const pick = brain.pickSize(sym, sizeUsd);
        buckets[sym] = pick.bucket;
        return usdToUsdcAtoms(pick.usd);
      };
      const opps = await scan(
        jup,
        tokens,
        sizeFor,
        extraLamports,
        solPrice,
        (sym, err) => {
          if (!running) return; // stopping: skip the remaining quotes quietly
          if (String(err).includes(" 429")) rateLimited = true;
          console.warn(`quote ${sym} failed: ${String(err).slice(0, 120)}`);
        },
        // Each token costs 2 requests; wait until they fit in every rate window.
        async () => {
          await waitForJupiter(2);
          if (!running) throw new Error("stopping");
        },
      );
      for (const o of opps) {
        brain.observeScan(o.symbol, o.eval.netBps, o.eval.netUsd, buckets[o.symbol]);
        const wasHot = brain.isHot(o.symbol);
        const move = brain.observePrice(o.symbol, buckets[o.symbol], Number(o.leg1.outAmount) / Number(o.leg1.inAmount));
        if (move !== null && !wasHot && brain.isHot(o.symbol)) {
          console.log(`${o.symbol} is moving fast (${move.toFixed(0)}bps); watching it closely`);
        }
      }
      if (opps[0]) brain.observeCycle(opps[0].eval.netBps, opps[0].symbol);

      // Rank by what the brain expects really to happen, not the raw quote.
      const expected = (o: (typeof opps)[number]) => brain.expectedNetBps(o.symbol, o.eval.netBps);
      const best = [...opps].sort((a, b) => expected(b) - expected(a))[0];
      if (best) {
        const exp = expected(best);
        console.log(
          `best ${best.symbol} $${best.eval.inUsd.toFixed(2)}: net ${best.eval.netBps.toFixed(1)}bps ` +
            (Math.abs(exp - best.eval.netBps) >= 0.1 ? `(expect ${exp.toFixed(1)}) ` : "") +
            `($${best.eval.netUsd.toFixed(4)}) need ${brain.minProfitBps}bps [${best.routes}]`,
        );
      }

      if (best && brain.shouldAttempt(best.symbol, best.eval.netBps)) {
        const deps = { conn, jup, cfg, solPriceUsd: solPrice, tipAccount: pickTip() };
        let result: ExecResult;
        // Building a real transaction re-quotes once and fetches two sets of swap instructions.
        if (simulateAs || cfg.mode === "live") await waitForJupiter(3);
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
        // A landed trade moved real money: read fresh balances next cycle.
        if (cfg.mode === "live" && (result.status === "filled" || result.status === "failed")) balanceCache?.invalidate();
        if (result.verified && (result.status === "filled" || result.status === "rejected")) {
          const realBps = result.status === "filled" ? (result.netUsd / best.eval.inUsd) * 10_000 : 0;
          brain.observeReality(best.symbol, best.eval.netBps, realBps);
        }
        risk.recordResult(result.status);

        const line =
          `${result.status.toUpperCase()} ${best.symbol} $${best.eval.inUsd.toFixed(2)}: net $${result.netUsd.toFixed(4)}` +
          (result.signature ? ` https://solscan.io/tx/${result.signature}` : "") +
          (result.reason ? ` (${result.reason})` : "");
        if (result.status === "filled" || result.status === "failed") await notify(line);
        else console.log(line);
      }

      brain.observePace(rateLimited);
      nextWaitMs = brain.nextIntervalMs(best?.eval.netBps, cfg.scanIntervalMs);
      const focus = brain.plannedRequests() < TOKENS_PER_SCAN * 2 ? brain.hotSymbols() : [];
      if (rateLimited) {
        nextWaitMs = Math.max(nextWaitMs, RATE_LIMIT_BACKOFF_MS);
        console.warn(`Jupiter says too many requests; slowing down (safe pace now ${brain.paceFloorMs / 1000}s)`);
      }
      publish({
        state: "scanning",
        note: rateLimited ? "Jupiter rate limit: backing off" : undefined,
        tradeSizeUsd: sizeUsd,
        paceFloorMs: brain.paceFloorMs,
        focus,
        shard: cfg.shard.count > 1 ? `${cfg.shard.index}/${cfg.shard.count}` : undefined,
        watching: Object.keys(pool).length,
        totalTokens: Object.keys(brain.tokenPool(cfg.tokens)).length,
        jupiterUsed: budget.used(),
        jupiterLimit: cfg.jupiterRpm,
        scansLastMin: scansInLastMinute(),
        nextScanInMs: nextWaitMs,
        lastBest: best && {
          symbol: best.symbol,
          netBps: best.eval.netBps,
          expectedBps: brain.expectedNetBps(best.symbol, best.eval.netBps),
          needBps: brain.minProfitBps,
        },
      });
      brain.save();
    } catch (err) {
      console.error("cycle error:", err);
      publish({ note: `last cycle error: ${String(err).slice(0, 100)}`, nextScanInMs: nextWaitMs });
    }
    await sleep(nextWaitMs);
  }

  brain.save();
  publish({ state: "stopped", note: undefined, nextScanInMs: 0 });
  await notify("Stopped.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
