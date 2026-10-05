import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, PublicKey, type Keypair } from "@solana/web3.js";
import { Brain, type SizeBucket } from "./brain.js";
import { RequestBudget, budgetedFetch } from "./budget.js";
import {
  TOKENS_PER_SCAN,
  isRealMoney,
  jupiterRateWindows,
  loadConfig,
  maxScansPerMin,
  tradeSizeUsd,
} from "./config.js";
import { discoverTokens } from "./discovery.js";
import { Funnel, STAGES, buildOppRecord } from "./funnel.js";
import { DEFAULT_PRIORS, LearningStats, scoreOpportunity } from "./stats.js";
import { costSettings as makeCostSettings } from "./config.js";
import { twoLegSpec, type CycleSpec } from "./cycle.js";
import { liveExecute, quoteOnlyExecute, simulateExecute, type ExecResult } from "./executor.js";
import { JitoClient } from "./jito.js";
import { JupiterClient } from "./jupiter.js";
import { Ledger, basisOf, moneyBasis, startOfUtcDay, startOfUtcMonth, type Basis } from "./ledger.js";
import { installConsoleRedaction, log } from "./log.js";
import { makeNotifier } from "./notify.js";
import { usdToUsdcAtoms } from "./profit.js";
import { RiskManager } from "./risk.js";
import { checkSecrets } from "./secrets.js";
import { fetchSolPriceUsd, scanCycles, type Scored } from "./scanner.js";
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
  installConsoleRedaction();
  const cfg = loadConfig();
  const secrets = checkSecrets(process.env, { mode: cfg.mode, envFilePath: ".env" });
  for (const w of secrets.warnings) log.warn(w);
  if (secrets.errors.length) {
    for (const e of secrets.errors) log.error(e);
    log.error("Refusing to start until the settings above are fixed.");
    process.exit(1);
  }
  const notify = makeNotifier(cfg);
  const haltFile = join(cfg.dataDir, "HALTED");
  if (existsSync(haltFile)) {
    log.error(`Bot is halted (${haltFile}). Read it, then delete it to restart.`);
    process.exit(1);
  }

  // Every Jupiter request goes through one counter covering a 60s and a 10s window, and the
  // bot waits for room before each request group, so it never bursts over Jupiter's limits.
  const budget = new RequestBudget(jupiterRateWindows(cfg.jupiterRpm));
  const jupFetch = budgetedFetch(budget);
  const jup = new JupiterClient(cfg.jupiterApi, jupFetch, cfg.jupiterApiKey);
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  // Only real-money modes ever hold a signer. Paper mode only needs the public address.
  const wallet: Keypair | undefined = isRealMoney(cfg.mode) && cfg.signingKey ? loadKeypair(cfg.signingKey) : undefined;
  const owner =
    wallet?.publicKey ??
    (cfg.walletPublicKey ? new PublicKey(cfg.walletPublicKey) : cfg.signingKey ? loadKeypair(cfg.signingKey).publicKey : undefined);
  const money: Basis = moneyBasis(cfg.mode);
  const jito = cfg.sendVia === "jito" ? new JitoClient(cfg.jitoUrl) : undefined;
  const ledger = new Ledger(join(cfg.dataDir, `trades-${cfg.mode}.jsonl`));
  const brain = new Brain(join(cfg.dataDir, `brain-${cfg.mode}.json`), {
    baseMinProfitBps: cfg.minProfitBps,
    minIntervalMs: cfg.minScanIntervalMs,
    minMsPerRequest: cfg.jupiterMsPerRequest,
    tokensPerCycle: TOKENS_PER_SCAN,
  });
  const balanceCache = owner ? new BalanceCache(conn, owner) : undefined;
  // The opportunity funnel is the source of truth for learning; replay it at startup.
  const funnelPath = join(cfg.dataDir, `opps-${cfg.mode}.jsonl`);
  const funnel = new Funnel(funnelPath);
  const pastOpps = Funnel.read(funnelPath);
  const learn = LearningStats.fromRecords(pastOpps, { ...DEFAULT_PRIORS, landing: cfg.landingPrior });
  // Today's funnel counts for the status screen: how many reached at least each stage.
  const funnelToday: Record<string, number> = {};
  let funnelDay = startOfUtcDay(Date.now());
  const countStage = (o: import("./funnel.js").OppRecord) => {
    for (const st of STAGES.slice(0, STAGES.indexOf(o.stage) + 1)) funnelToday[st] = (funnelToday[st] ?? 0) + 1;
  };
  for (const o of pastOpps) if (o.ts >= funnelDay) countStage(o);
  const risk = new RiskManager(cfg);
  // Older versions let quote-only paper wins lower the profit bar. Without any
  // result checked on-chain, there is no real evidence for that: undo it.
  if (brain.restoredFromBackup) log.warn("brain file was unreadable; restored what it learned from the backup copy");
  if (brain.minProfitBps < cfg.minProfitBps && !ledger.all().some((r) => r.verified && r.status === "filled")) {
    brain.state.minProfitBps = cfg.minProfitBps;
  }
  const costs = makeCostSettings(cfg);

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
      log.warn(`could not load Jito tip accounts (will retry): ${String(err).slice(0, 120)}`);
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
  let lastOpp: import("./funnel.js").OppRecord | undefined;

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

  const how = isRealMoney(cfg.mode)
    ? `REAL transactions via ${cfg.sendVia.toUpperCase()}` +
      (cfg.mode === "micro" ? `, capped at $${cfg.microMaxTradeUsd} per trade` : "")
    : owner
      ? "testing each trade on-chain with your wallet's public address (nothing is sent)"
      : "quote-only (add WALLET_PUBLIC_KEY for realistic on-chain testing; quoted amounts are not profit)";
  await notify(
    `Started in ${cfg.mode.toUpperCase()} mode, ${how}` +
      (owner ? `. Wallet ${owner.toBase58()}` : "") +
      `. Loss floor $${cfg.lossFloorUsd}, no profit cap. SOL=$${solPrice.toFixed(2)}`,
  );
  log.info(
    `Jupiter: ${cfg.jupiterApiKey ? "using your API key" : "no API key"} (${cfg.jupiterRpm} requests/min), ` +
      `so up to ~${maxScansPerMin(cfg.jupiterMsPerRequest).toFixed(1)} full scans/min, ` +
      `or ~${maxScansPerMin(cfg.jupiterMsPerRequest, 2).toFixed(0)} focus scans/min on a moving token`,
  );

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
          if (added.length) log.event(`brain found new tokens to watch: ${added.join(", ")}`);
        } catch (err) {
          log.warn(`token discovery failed (keeps current list): ${String(err).slice(0, 120)}`);
        }
      }
      await refreshTipAccounts();

      if (now - solPriceAt > SOL_PRICE_REFRESH_MS) {
        await waitForJupiter(1);
        solPrice = await fetchSolPriceUsd(jup);
        solPriceAt = now;
      }

      const records = ledger.all();
      // Only simulated (paper) or realized (micro/live) amounts count as money; quoted never does.
      const moneyRecords = records.filter((r) => basisOf(r) === money);

      // Daily and monthly bookkeeping.
      if (startOfUtcDay(now) !== lastDay) {
        const pnl = ledger.pnlBetween(lastDay, startOfUtcDay(now), records, [money]);
        const quoted = ledger.pnlBetween(lastDay, startOfUtcDay(now), records, ["quoted"]);
        await notify(
          `Daily ${money} P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}` +
            (quoted ? ` (quotes alone suggested $${quoted.toFixed(4)}; not real)` : "") +
            "\n" +
            brain.thoughts(cfg.minProfitBps).map((t) => `- ${t}`).join("\n"),
        );
        lastDay = startOfUtcDay(now);
      }
      if (startOfUtcMonth(now) !== lastMonth) {
        await notify(formatVerdict(monthVerdict(moneyRecords, lastMonth, cfg.monthlyCostsUsd)));
        lastMonth = startOfUtcMonth(now);
        if (shouldRetire(moneyRecords, now, cfg.monthlyCostsUsd, cfg.sustainStopAfterMonths, moneyRecords[0]?.ts)) {
          await halt(`did not cover its bills for ${cfg.sustainStopAfterMonths} months in a row`);
        }
      }

      // Wallet value: real on-chain in micro/live; in paper, start + simulated P&L only.
      const paperValue = cfg.startingBalanceUsd + moneyRecords.reduce((s, r) => s + r.netUsd, 0);
      let valueUsd = paperValue;
      let usdcUsd = paperValue;
      let simulateAs: PublicKey | undefined;
      if (owner && balanceCache) {
        const b = await balanceCache.get();
        const realUsdc = Number(b.usdcAtoms) / 1e6;
        if (isRealMoney(cfg.mode)) {
          valueUsd = walletValueUsd(b, solPrice);
          usdcUsd = realUsdc;
        } else if (realUsdc >= 1 && b.lamports / 1e9 >= MIN_SOL_TO_SIMULATE) {
          // On-chain simulation can only spend what the wallet really holds.
          usdcUsd = Math.min(paperValue, realUsdc);
          simulateAs = owner;
        } else if (!warnedUnfunded) {
          warnedUnfunded = true;
          log.warn(
            `wallet needs at least $1 USDC and ${MIN_SOL_TO_SIMULATE} SOL to test on-chain; quote-only until funded`,
          );
        }
      }

      const decision = risk.check(valueUsd, ledger.pnlBetween(startOfUtcDay(now), undefined, records, [money]), now);
      publish({ walletValueUsd: valueUsd, onChainTesting: cfg.mode === "paper" && !!simulateAs });
      if (!decision.ok) {
        if (decision.halt) await halt(decision.reason);
        publish({ state: "paused", note: decision.reason, nextScanInMs: cfg.scanIntervalMs * 4 });
        log.event(`paused: ${decision.reason}`);
        await sleep(cfg.scanIntervalMs * 4);
        continue;
      }

      let sizeUsd = tradeSizeUsd(cfg, usdcUsd);
      if (cfg.mode === "micro") sizeUsd = Math.min(sizeUsd, cfg.microMaxTradeUsd);
      if (sizeUsd < 1) {
        publish({ state: "waiting", note: `only $${usdcUsd.toFixed(2)} USDC available`, nextScanInMs: cfg.scanIntervalMs * 4 });
        log.info(`only $${usdcUsd.toFixed(2)} USDC available; waiting`);
        await sleep(cfg.scanIntervalMs * 4);
        continue;
      }

      const tokens = brain.pickTokens(brain.tokenPool(cfg.tokens));
      scanTimes.push(Date.now());
      const specs: CycleSpec[] = Object.entries(tokens).map(([sym, mint]) => twoLegSpec(sym, mint));
      const buckets: Record<string, SizeBucket> = {};
      const sizeFor = (spec: CycleSpec) => {
        const pick = brain.pickSize(spec.symbol, sizeUsd);
        buckets[spec.symbol] = pick.bucket;
        return usdToUsdcAtoms(pick.usd);
      };
      const scored = await scanCycles(
        jup,
        specs,
        sizeFor,
        solPrice,
        costs,
        (spec, err) => {
          if (!running) return; // stopping: skip the remaining quotes quietly
          if (String(err).includes(" 429")) rateLimited = true;
          log.warn(`quote ${spec.symbol} failed: ${String(err).slice(0, 120)}`);
        },
        // Each leg costs 1 request; wait until the cycle fits in every rate window.
        async (spec) => {
          await waitForJupiter(spec.path.length - 1);
          if (!running) throw new Error("stopping");
        },
      );
      for (const { cycle, val } of scored) {
        brain.observeScan(cycle.symbol, val.netBps, val.netUsd, buckets[cycle.symbol]);
        const wasHot = brain.isHot(cycle.symbol);
        const leg1 = cycle.legs[0];
        const move = brain.observePrice(cycle.symbol, buckets[cycle.symbol], Number(leg1.outAmount) / Number(leg1.inAmount));
        if (move !== null && !wasHot && brain.isHot(cycle.symbol)) {
          log.event(`${cycle.symbol} is moving fast (${move.toFixed(0)}bps); watching it closely`);
        }
      }
      if (scored[0]) brain.observeCycle(scored[0].val.netBps, scored[0].cycle.symbol);

      // Rank by expected value (net × learned chance of success), discounted for stale
      // quotes, slow execution, price impact and unproven tokens — not by the raw quote.
      const withWallet = !!simulateAs || isRealMoney(cfg.mode);
      const decisionTs = Date.now();
      const rank = (x: Scored) => {
        const p = learn.probabilities(x.cycle.symbol, x.cycle.routes, cfg.mode, withWallet);
        const ev = learn.expectedValue(x.val.netUsd, x.val.costs.networkUsd, p, cfg.mode, withWallet);
        const score = scoreOpportunity({
          evUsd: ev,
          quoteAgeMs: decisionTs - x.cycle.quotedAt,
          expectedLatencyMs: learn.medianishLatencyMs(),
          priceImpactBps: x.cycle.priceImpactBps,
          maxImpactBps: cfg.maxPriceImpactBps,
          discovered: x.cycle.tokens.some((t) => !(t in cfg.tokens)),
        });
        return { p, ev, score };
      };
      const ranked = scored.map((x) => ({ ...x, ...rank(x) })).sort((a, b) => b.score - a.score);
      const expected = (x: Scored) => brain.expectedNetBps(x.cycle.symbol, x.val.netBps);
      const best = ranked[0];
      if (best) {
        const exp = expected(best);
        log.info(
          `best ${best.cycle.symbol} $${best.val.inUsd.toFixed(2)}: quoted net ${best.val.netBps.toFixed(1)}bps ` +
            (Math.abs(exp - best.val.netBps) >= 0.1 ? `(expect ${exp.toFixed(1)}) ` : "") +
            `($${best.val.netUsd.toFixed(4)} after $${best.val.costs.totalUsd.toFixed(4)} costs) ` +
            `need ${brain.minProfitBps}bps, EV $${best.ev.toFixed(4)} (P=${(best.p.success * 100).toFixed(0)}%) ` +
            `[${best.cycle.routes}]`,
        );
      }

      if (
        best &&
        brain.shouldAttempt(best.cycle.symbol, best.val.netBps) &&
        best.ev >= cfg.minExpectedProfitUsd &&
        best.cycle.priceImpactBps <= cfg.maxPriceImpactBps
      ) {
        const { cycle, val } = best;
        const deps = {
          conn,
          jup,
          cfg,
          costSettings: costs,
          solPriceUsd: solPrice,
          tipAccount: pickTip(),
          floorBps: Math.min(brain.minProfitBps, cfg.minProfitBps),
        };
        const legs = cycle.legs.length;
        let result: ExecResult;
        // A fresh quote of every leg, plus (to build a real transaction) one swap-instructions call per leg.
        await waitForJupiter(simulateAs || isRealMoney(cfg.mode) ? legs * 2 : legs);
        if (isRealMoney(cfg.mode) && wallet) result = await liveExecute(cycle, val, wallet, { ...deps, jito });
        else if (simulateAs) result = await simulateExecute(cycle, val, simulateAs, deps);
        else result = await quoteOnlyExecute(cycle, val, deps);

        const basis: Basis = isRealMoney(cfg.mode) ? "realized" : result.verified ? "simulated" : "quoted";
        const opp = buildOppRecord({
          id: funnel.nextId(decisionTs),
          mode: cfg.mode,
          cycle,
          val,
          result,
          decisionTs,
          expected: { pSuccess: best.p.success, evUsd: best.ev, assumed: best.p.assumed },
          solPriceUsd: solPrice,
        });
        funnel.record(opp);
        learn.observe(opp);
        lastOpp = opp;
        if (startOfUtcDay(opp.ts) !== funnelDay) {
          funnelDay = startOfUtcDay(opp.ts);
          for (const k of Object.keys(funnelToday)) delete funnelToday[k];
        }
        countStage(opp);
        ledger.append({
          ts: Date.now(),
          mode: cfg.mode,
          symbol: cycle.symbol,
          status: result.status,
          inUsd: val.inUsd,
          netUsd: result.netUsd,
          feeUsd: result.feeUsd,
          signature: result.signature,
          reason: result.reason,
          verified: result.verified,
          basis,
          opportunityId: opp.id,
        });
        brain.observeTrade(cycle.symbol, result.status, result.netUsd, result.verified === true);
        // A landed trade moved real money: read fresh balances next cycle.
        if (isRealMoney(cfg.mode) && (result.status === "filled" || result.status === "failed")) balanceCache?.invalidate();
        if (result.verified && (result.status === "filled" || result.status === "rejected")) {
          const realBps = result.status === "filled" ? (result.netUsd / val.inUsd) * 10_000 : 0;
          brain.observeReality(cycle.symbol, val.netBps, realBps);
        }
        risk.recordResult(result.status);
        if (result.status === "timeout") {
          await halt(`could not confirm whether a real trade landed (${result.reason}). Check it before restarting`);
        }

        const label = isRealMoney(cfg.mode)
          ? `${result.status.toUpperCase()} (real)`
          : result.status === "stale"
            ? "GONE AT RE-QUOTE"
            : result.verified
              ? `SIMULATED ${result.status === "filled" ? "OK" : result.status.toUpperCase()}`
              : "QUOTE-ONLY (not real profit)";
        const exec = result.executable ? ` | fresh re-quote ${result.executable.netBps.toFixed(1)}bps` : "";
        const line =
          `${opp.id} ${label} ${cycle.symbol} $${val.inUsd.toFixed(2)}: ${basis} net $${result.netUsd.toFixed(4)}${exec}` +
          (result.signature ? ` https://solscan.io/tx/${result.signature}` : "") +
          (result.reason ? ` (${result.reason})` : "");
        if (result.status === "filled" || result.status === "failed") await notify(line);
        else log.event(line);
      }

      brain.observePace(rateLimited);
      nextWaitMs = brain.nextIntervalMs(best?.val.netBps, cfg.scanIntervalMs);
      const focus = brain.plannedRequests() < TOKENS_PER_SCAN * 2 ? brain.hotSymbols() : [];
      if (rateLimited) {
        nextWaitMs = Math.max(nextWaitMs, RATE_LIMIT_BACKOFF_MS);
        log.warn(`Jupiter says too many requests; slowing down (safe pace now ${brain.paceFloorMs / 1000}s)`);
      }
      publish({
        state: "scanning",
        note: rateLimited ? "Jupiter rate limit: backing off" : undefined,
        tradeSizeUsd: sizeUsd,
        paceFloorMs: brain.paceFloorMs,
        focus,
        jupiterUsed: budget.used(),
        jupiterLimit: cfg.jupiterRpm,
        scansLastMin: scansInLastMinute(),
        funnelToday: { ...funnelToday },
        lastOpp: lastOpp && {
          id: lastOpp.id,
          symbol: lastOpp.symbol,
          stage: lastOpp.stage,
          result: lastOpp.result,
          totalMs: lastOpp.lat.totalMs,
          quotedBps: lastOpp.quoted.netBps,
          execBps: lastOpp.executable?.netBps,
        },
        nextScanInMs: nextWaitMs,
        lastBest: best && {
          symbol: best.cycle.symbol,
          netBps: best.val.netBps,
          expectedBps: brain.expectedNetBps(best.cycle.symbol, best.val.netBps),
          needBps: brain.minProfitBps,
        },
      });
      brain.save();
    } catch (err) {
      log.error("cycle error:", err);
      publish({ note: `last cycle error: ${String(err).slice(0, 100)}`, nextScanInMs: nextWaitMs });
    }
    await sleep(nextWaitMs);
  }

  brain.save();
  publish({ state: "stopped", note: undefined, nextScanInMs: 0 });
  await notify("Stopped.");
}

main().catch((err) => {
  log.error(err);
  process.exit(1);
});
