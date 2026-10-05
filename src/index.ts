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
  safetyThresholds,
  tradeSizeUsd,
} from "./config.js";
import { discoverTokens } from "./discovery.js";
import { timeoutFetch } from "./http.js";
import { gateThresholds, goLiveVerdict, loadGateInput } from "./gate.js";
import { HALT_FILE, disableTrading, tradingDisabled } from "./killswitch.js";
import { Funnel, STAGES, buildOppRecord } from "./funnel.js";
import { DEFAULT_PRIORS, LearningStats, scoreOpportunity } from "./stats.js";
import { costSettings as makeCostSettings } from "./config.js";
import { valueCycle, type Valuation } from "./costs.js";
import { quoteCycle, specOf, twoLegSpec, type Cycle, type CycleSpec } from "./cycle.js";
import { Rotation, triangleSpecs } from "./triangles.js";
import { evaluateLadder, ladderSizes, pickBestSize } from "./sizer.js";
import { liveExecute, quoteOnlyExecute, simulateExecute, type ExecResult } from "./executor.js";
import { JitoClient } from "./jito.js";
import { JupiterClient } from "./jupiter.js";
import { Ledger, basisOf, moneyBasis, startOfUtcDay, startOfUtcMonth, type Basis } from "./ledger.js";
import { installConsoleRedaction, log } from "./log.js";
import { makeNotifier } from "./notify.js";
import { usdToUsdcAtoms } from "./profit.js";
import { RiskManager } from "./risk.js";
import { PoolWatcher, rpcSubscriber } from "./poolwatch.js";
import { checkSecrets } from "./secrets.js";
import { TokenSafety, canAct, canScan, type SafetyState } from "./tokensafety.js";
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
/** While the kill switch is on, look for it being lifted this often. */
const KILL_SWITCH_POLL_MS = 5_000;
/**
 * Exit code for "refused to start" (bad settings, LIVE gate not passed).
 * deploy/termux-run.sh does not restart on it: restarting cannot fix it.
 */
const EXIT_REFUSED = 2;
// Sleep that a stop signal can cut short, so stopping the bot is immediate. The idle
// sleep between scans can also be cut short by a pool event; waits for the rate
// limit cannot (that would send requests before there is room for them).
let wakeAny: (() => void) | undefined;
let wakeIdle: (() => void) | undefined;
const sleep = (ms: number, idle = false) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wakeAny = undefined;
      if (idle) wakeIdle = undefined;
      resolve();
    };
    const timer = setTimeout(done, ms);
    wakeAny = done;
    if (idle) wakeIdle = done;
  });
/** A pool event can start the next scan early, but only this many in a row before a full scan. */
const MAX_EVENT_SCANS_IN_A_ROW = 2;
/** At most this many dirty tokens per event scan (each costs a quote per leg). */
const EVENT_SCAN_TOKENS = 2;
/** Triangles per triangle scan: 2 × 3 legs costs the same as a 3-token two-leg scan. */
const TRIANGLES_PER_SCAN = 2;

async function main() {
  installConsoleRedaction();
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig();
  } catch (err) {
    log.error(`Refusing to start: ${(err as Error).message}`);
    process.exit(EXIT_REFUSED);
  }
  const secrets = checkSecrets(process.env, { mode: cfg.mode, envFilePath: ".env" });
  for (const w of secrets.warnings) log.warn(w);
  if (secrets.errors.length) {
    for (const e of secrets.errors) log.error(e);
    log.error("Refusing to start until the settings above are fixed.");
    process.exit(EXIT_REFUSED);
  }
  const httpFetch = timeoutFetch();
  const notify = makeNotifier(cfg, httpFetch);
  const haltFile = join(cfg.dataDir, HALT_FILE);
  if (existsSync(haltFile)) {
    log.error(`Bot is halted (${haltFile}). Read it, then delete it to restart.`);
    process.exit(EXIT_REFUSED);
  }

  // The go-live gate: paper profits are never evidence. LIVE (adaptive size)
  // needs proven MICRO results; MICRO is only warned about, since every trade
  // is capped at MICRO_MAX_TRADE_USD and its purpose is to collect that proof.
  if (isRealMoney(cfg.mode)) {
    const verdict = goLiveVerdict(loadGateInput(cfg.dataDir), gateThresholds(cfg));
    if (cfg.mode === "live" && !verdict.live.ok) {
      log.error("LIVE mode refused: real execution has not proven itself yet.");
      for (const r of verdict.live.reasons) log.error(`  - ${r}`);
      log.error("Prove execution with tiny capped trades first (npm run micro), then check: npm run report");
      process.exit(EXIT_REFUSED);
    }
    if (cfg.mode === "micro" && !verdict.micro.ok) {
      log.warn("MICRO is starting although the paper results do not recommend it yet:");
      for (const r of verdict.micro.reasons) log.warn(`  - ${r}`);
      log.warn(`Every trade is capped at $${cfg.microMaxTradeUsd}.`);
    }
  }

  // Every Jupiter request goes through one counter covering a 60s and a 10s window, and the
  // bot waits for room before each request group, so it never bursts over Jupiter's limits.
  const budget = new RequestBudget(jupiterRateWindows(cfg.jupiterRpm));
  const jupFetch = budgetedFetch(budget, httpFetch);
  const jup = new JupiterClient(cfg.jupiterApi, jupFetch, cfg.jupiterApiKey);
  const conn = new Connection(cfg.rpcUrl, { commitment: "confirmed", fetch: httpFetch, wsEndpoint: cfg.rpcWsUrl });
  // Only real-money modes ever hold a signer. Paper mode only needs the public address.
  const wallet: Keypair | undefined = isRealMoney(cfg.mode) && cfg.signingKey ? loadKeypair(cfg.signingKey) : undefined;
  const owner =
    wallet?.publicKey ??
    (cfg.walletPublicKey ? new PublicKey(cfg.walletPublicKey) : cfg.signingKey ? loadKeypair(cfg.signingKey).publicKey : undefined);
  const money: Basis = moneyBasis(cfg.mode);
  const jito = cfg.sendVia === "jito" ? new JitoClient(cfg.jitoUrl, httpFetch) : undefined;
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
  // Today's funnel counts for the status screen: how many reached at least each stage.
  const funnelToday: Record<string, number> = {};
  let funnelDay = startOfUtcDay(Date.now());
  const countStage = (o: import("./funnel.js").OppRecord) => {
    for (const st of STAGES.slice(0, STAGES.indexOf(o.stage) + 1)) funnelToday[st] = (funnelToday[st] ?? 0) + 1;
  };
  // (In a function so the replayed records can be freed once counted.)
  const learn = ((past) => {
    for (const o of past) if (o.ts >= funnelDay) countStage(o);
    return LearningStats.fromRecords(past, { ...DEFAULT_PRIORS, landing: cfg.landingPrior });
  })(Funnel.read(funnelPath));
  const risk = new RiskManager(cfg);
  // Token safety: what each token's mint allows (fees, hooks, freezes...) and how healthy its market is.
  const safety = new TokenSafety(join(cfg.dataDir, "token-safety.json"), {
    liveTokens: cfg.liveTokens,
    thresholds: safetyThresholds(cfg),
  });
  const lastSafety = new Map<string, SafetyState>();
  // Event triggers: re-quote a token as soon as a pool its route uses changes.
  const watcher = cfg.eventTriggers
    ? new PoolWatcher(
        rpcSubscriber(conn),
        {
          maxPools: cfg.maxWatchedPools,
          dailyEventCap: cfg.eventDailyCap,
          debounceMs: cfg.eventDebounceMs,
          busyPerMin: cfg.busyPoolPerMin,
        },
        () => wakeIdle?.(),
        Date.now,
        (m) => log.warn(m),
      )
    : undefined;
  const lastPools = new Map<string, string[]>();
  let quoteMsAvg: number | undefined;
  let eventScans = 0;
  let fullScans = 0;
  const triangleTurns = new Rotation<CycleSpec>();
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
      wakeAny?.();
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
  let killSwitchOn = false;
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
    // Emergency stop (npm run stop-trading, or tripped by an unexpected outcome):
    // do nothing but wait until a person re-enables trading.
    const kill = tradingDisabled(cfg.dataDir);
    if (kill.disabled) {
      if (!killSwitchOn) {
        killSwitchOn = true;
        await notify(`TRADING DISABLED: ${kill.reason}. Waiting. Re-enable after checking: npm run enable-trading`);
      }
      publish({ state: "disabled", note: kill.reason, nextScanInMs: KILL_SWITCH_POLL_MS });
      await sleep(KILL_SWITCH_POLL_MS);
      continue;
    }
    if (killSwitchOn) {
      killSwitchOn = false;
      log.event("trading re-enabled by hand; resuming");
    }
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
          for (const [sym, mint] of Object.entries(found.tokens)) {
            if (found.facts[mint]) safety.noteMarket(mint, sym, found.facts[mint]);
          }
          // Skip tokens already known to be blocked; new ones are checked before their first quote.
          const candidates = Object.fromEntries(
            Object.entries(found.tokens).filter(([sym, mint]) => safety.verdict(sym, mint, false, now).state !== "BLOCKED"),
          );
          const added = brain.learnTokens(candidates, cfg.tokens, cfg.maxTokens);
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

      // Check new tokens' mints (and every token's, daily) before quoting them.
      const pool = brain.tokenPool(cfg.tokens);
      if (safety.due(Object.values(pool), now).length) {
        try {
          await safety.refresh(conn, pool, now);
        } catch (err) {
          log.warn(`token safety check failed (unchecked tokens stay paper-only; retrying later): ${String(err).slice(0, 120)}`);
        }
      }
      const safetyOf = (sym: string, mint: string) => safety.verdict(sym, mint, sym in cfg.tokens, now);
      for (const [sym, mint] of Object.entries(pool)) {
        const v = safetyOf(sym, mint);
        if (lastSafety.get(mint) !== v.state) {
          lastSafety.set(mint, v.state);
          if (v.state !== "LIVE_ALLOWED" || v.reasons.length) log.event(`token safety: ${sym} is ${v.state} (${v.reasons.join("; ")})`);
        }
        // A blocked discovered token would never be quoted, so the brain would never drop it.
        if (v.state === "BLOCKED" && brain.forgetToken(sym)) log.event(`brain dropped ${sym}: blocked by the safety check`);
      }
      const scannable = Object.fromEntries(Object.entries(pool).filter(([sym, mint]) => canScan(safetyOf(sym, mint).state, cfg.mode)));
      if (!Object.keys(scannable).length) {
        const why = isRealMoney(cfg.mode) ? "no token is LIVE_ALLOWED yet (safety check pending or failed)" : "every token is blocked";
        publish({ state: "waiting", note: why, nextScanInMs: cfg.scanIntervalMs * 4 });
        log.warn(why);
        await sleep(cfg.scanIntervalMs * 4);
        continue;
      }
      // A pool just changed: quote those tokens now, while any gap is fresh
      // (with a full scan every few turns so nothing else is ignored).
      const dirty = (watcher?.takeDirty() ?? []).filter((d) => d.symbol in scannable);
      const marketTs = new Map<string, number>();
      let tokens: Record<string, string> = {};
      let triangles: CycleSpec[] = [];
      if (dirty.length && eventScans < MAX_EVENT_SCANS_IN_A_ROW) {
        eventScans += 1;
        tokens = Object.fromEntries(dirty.slice(0, EVENT_SCAN_TOKENS).map((d) => [d.symbol, scannable[d.symbol]]));
        for (const d of dirty.slice(EVENT_SCAN_TOKENS)) watcher!.remark(d.symbol, d.ts);
      } else {
        eventScans = 0;
        fullScans += 1;
        // Every few full scans: triangles through the pivot, among configured tokens it may act on.
        if (cfg.triangles && fullScans % cfg.triangleEvery === 0) {
          const liquid = Object.fromEntries(
            Object.entries(scannable).filter(([sym, mint]) => sym in cfg.tokens && canAct(safetyOf(sym, mint).state, cfg.mode)),
          );
          triangles = triangleTurns.take(triangleSpecs(liquid, cfg.trianglePivot), TRIANGLES_PER_SCAN);
        }
        if (!triangles.length) tokens = brain.pickTokens(scannable);
        for (const d of dirty) if (!(d.symbol in tokens)) watcher!.remark(d.symbol, d.ts);
      }
      for (const d of dirty) if (d.symbol in tokens) marketTs.set(d.symbol, d.ts);
      scanTimes.push(Date.now());
      const specs: CycleSpec[] = triangles.length
        ? triangles
        : Object.entries(tokens).map(([sym, mint]) => twoLegSpec(sym, mint));
      const buckets: Record<string, SizeBucket> = {};
      const sizeFor = (spec: CycleSpec) => {
        const pick = brain.pickSize(spec.symbol, sizeUsd);
        buckets[spec.symbol] = pick.bucket;
        return usdToUsdcAtoms(pick.usd);
      };

      // Rank by expected value (net × learned chance of success), discounted for stale
      // quotes, slow execution, price impact and unproven tokens — not by the raw quote.
      const withWallet = !!simulateAs || isRealMoney(cfg.mode);
      const rank = (x: Scored, at = Date.now()) => {
        const p = learn.probabilities(x.cycle.symbol, x.cycle.routes, cfg.mode, withWallet);
        const ev = learn.expectedValue(x.val.netUsd, x.val.costs.networkUsd, p, cfg.mode, withWallet);
        const score = scoreOpportunity({
          evUsd: ev,
          quoteAgeMs: at - x.cycle.quotedAt,
          expectedLatencyMs: learn.medianishLatencyMs(),
          priceImpactBps: x.cycle.priceImpactBps,
          maxImpactBps: cfg.maxPriceImpactBps,
          discovered: x.cycle.tokens.some((t) => !(t in cfg.tokens)),
        });
        return { p, ev, score };
      };
      // Every token the cycle passes through must allow acting in this mode.
      const safeToAct = (x: Scored) =>
        x.cycle.tokens.every((sym, i) => canAct(safetyOf(sym, x.cycle.path[i + 1]).state, cfg.mode));
      const worthActing = (x: Scored, ev: number) =>
        safeToAct(x) &&
        brain.shouldAttempt(x.cycle.symbol, x.val.netBps) &&
        ev >= cfg.minExpectedProfitUsd &&
        x.cycle.priceImpactBps <= cfg.maxPriceImpactBps;

      const scored = await scanCycles(jup, specs, sizeFor, solPrice, costs, {
        onError: (spec, err) => {
          if (!running) return; // stopping: skip the remaining quotes quietly
          if (String(err).includes(" 429")) rateLimited = true;
          log.warn(`quote ${spec.symbol} failed: ${String(err).slice(0, 120)}`);
        },
        // Each leg costs 1 request. Wait until the cycle fits in every rate window
        // AND enough room stays free to execute a gap at once (re-quote, and build
        // when testing on-chain): a gap found but executed seconds later is gone.
        beforeEach: async (spec) => {
          const legs = spec.path.length - 1;
          await waitForJupiter(legs + (withWallet ? legs * 2 : legs));
          if (!running) throw new Error("stopping");
        },
        // Gaps last moments: act on the first one worth it instead of quoting the rest first.
        stopAfter: (x) => worthActing(x, rank(x).ev),
        marketTsFor: (spec) => marketTs.get(spec.symbol),
      });
      for (const { cycle } of scored) {
        lastPools.set(cycle.symbol, cycle.pools);
        // Measured time to quote every leg of a cycle, from this device.
        const ms = cycle.quotedAt - cycle.quoteStartedAt;
        quoteMsAvg = quoteMsAvg === undefined ? ms : quoteMsAvg * 0.8 + ms * 0.2;
      }
      for (const { cycle, val } of scored) {
        brain.observeScan(cycle.symbol, val.netBps, val.netUsd, buckets[cycle.symbol]);
        if (cycle.kind !== "two-leg") continue; // price moves are tracked per token, on its own round trip
        const wasHot = brain.isHot(cycle.symbol);
        const leg1 = cycle.legs[0];
        const move = brain.observePrice(cycle.symbol, buckets[cycle.symbol], Number(leg1.outAmount) / Number(leg1.inAmount));
        if (move !== null && !wasHot && brain.isHot(cycle.symbol)) {
          log.event(`${cycle.symbol} is moving fast (${move.toFixed(0)}bps); watching it closely`);
        }
      }
      if (scored[0]) brain.observeCycle(scored[0].val.netBps, scored[0].cycle.symbol);

      const rankedAt = Date.now();
      const ranked = scored.map((x) => ({ ...x, ...rank(x, rankedAt) })).sort((a, b) => b.score - a.score);
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

      if (best && worthActing(best, best.ev)) {
        // Size ladder: try a few sizes (within every limit) and keep the best expected value.
        // Only with requests free right now (keeping enough to execute): waiting seconds
        // for room to compare sizes would let the gap close.
        let { cycle, val } = best;
        let chosenP = best.p;
        let chosenEv = best.ev;
        let ladder: import("./funnel.js").OppRecord["ladder"];
        let ladderSaysNo = false;
        const legsN = best.cycle.legs.length;
        const execRequests = simulateAs || isRealMoney(cfg.mode) ? legsN * 2 : legsN;
        const spareSizes = Math.max(0, Math.floor((budget.available() - execRequests) / legsN));
        const points = Math.min(cfg.maxLadderPoints, 1 + spareSizes);
        const sizes = ladderSizes(cfg.sizeLadderUsd, { maxUsd: sizeUsd, minUsd: 1 }, points, best.val.inUsd);
        if (sizes.length > 1) {
          const evOf = (c: Cycle, v: Valuation) =>
            learn.expectedValue(v.netUsd, v.costs.networkUsd, learn.probabilities(c.symbol, c.routes, cfg.mode, withWallet), cfg.mode, withWallet);
          const points = await evaluateLadder(
            sizes,
            async (usd) => {
              await waitForJupiter(best.cycle.legs.length);
              const c = await quoteCycle(jup, specOf(best.cycle), usdToUsdcAtoms(usd), { marketTs: best.cycle.marketTs });
              return { cycle: c, val: valueCycle(c, solPrice, costs) };
            },
            evOf,
            cfg.maxPriceImpactBps,
            best,
            (usd, err) => log.warn(`size $${usd} quote failed: ${String(err).slice(0, 100)}`),
          );
          ladder = points.map((p) => ({ sizeUsd: p.sizeUsd, netUsd: p.val.netUsd, netBps: p.val.netBps, evUsd: p.evUsd, impactBps: p.impactBps }));
          const top = pickBestSize(points);
          if (top) {
            cycle = top.cycle;
            val = top.val;
            chosenEv = top.evUsd;
            chosenP = learn.probabilities(cycle.symbol, cycle.routes, cfg.mode, withWallet);
          } else {
            ladderSaysNo = true;
          }
        }
        // Detection -> decision includes the ladder's extra quotes: that time counts too.
        const decidedAt = Date.now();
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
        // The scan took seconds; honour a kill switch set meanwhile before sending anything.
        if (tradingDisabled(cfg.dataDir).disabled) continue;
        let result: ExecResult;
        // A fresh quote of every leg, plus (to build a real transaction) one swap-instructions call per leg.
        if (!ladderSaysNo) await waitForJupiter(simulateAs || isRealMoney(cfg.mode) ? legs * 2 : legs);
        if (ladderSaysNo) result = { status: "skipped", netUsd: 0, feeUsd: 0, t: {}, reason: "no trade size had positive expected value at fresh quotes" };
        else if (isRealMoney(cfg.mode) && wallet) result = await liveExecute(cycle, val, wallet, { ...deps, jito });
        else if (simulateAs) result = await simulateExecute(cycle, val, simulateAs, deps);
        else result = await quoteOnlyExecute(cycle, val, deps);

        const basis: Basis = isRealMoney(cfg.mode) ? "realized" : result.verified ? "simulated" : "quoted";
        const opp = buildOppRecord({
          id: funnel.nextId(decidedAt),
          mode: cfg.mode,
          cycle,
          val,
          result,
          decisionTs: decidedAt,
          detected: best.cycle,
          expected: { pSuccess: chosenP.success, evUsd: chosenEv, assumed: chosenP.assumed },
          solPriceUsd: solPrice,
          ladder,
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
        // Only checked outcomes count toward loss streaks; quote-only numbers are not results.
        risk.recordResult(result.status, Date.now(), result.verified ? result.netUsd : 0);
        // Something that should not happen with real money (a landing that can't be
        // confirmed, a loss the on-chain floor should have prevented): stop and ask a person.
        const unexpected = isRealMoney(cfg.mode) ? risk.unexpected(result.status, result.netUsd) : null;
        if (unexpected) {
          disableTrading(cfg.dataDir, `${unexpected} (${opp.id}${result.signature ? `, tx ${result.signature}` : ""})`);
          killSwitchOn = true;
          await notify(`TRADING DISABLED: ${unexpected} (${opp.id}). Check it, then: npm run enable-trading`);
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

      // Follow the pools of the most promising tokens the bot may act on.
      if (watcher) {
        const actable = Object.keys(scannable).filter((sym) => canAct(safetyOf(sym, scannable[sym]).state, cfg.mode));
        try {
          await watcher.watch(brain.rankTokens(actable).map((symbol) => ({ symbol, pools: lastPools.get(symbol) ?? [] })));
        } catch (err) {
          log.warn(`pool watching failed: ${String(err).slice(0, 120)}`);
        }
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
        events: watcher && { ...watcher.stats(), cap: cfg.eventDailyCap },
        quoteMs: quoteMsAvg === undefined ? undefined : Math.round(quoteMsAvg),
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
    await sleep(nextWaitMs, true);
  }

  brain.save();
  await watcher?.unwatchAll().catch(() => {});
  publish({ state: "stopped", note: undefined, nextScanInMs: 0 });
  await notify("Stopped.");
}

main().catch((err) => {
  log.error(err);
  process.exit(1);
});
