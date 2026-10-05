import { Connection, PublicKey } from "@solana/web3.js";
import { writeJsonAtomic } from "./atomic.js";
import { SOL_MINT, USDC_MINT, isRealMoney, jupiterMsPerRequest, loadConfig } from "./config.js";
import { timeoutFetch } from "./http.js";
import { JitoClient } from "./jito.js";
import { JupiterClient, type QuoteResponse } from "./jupiter.js";
import { installConsoleRedaction } from "./log.js";
import { isAlive, readStatus } from "./status-file.js";
import { join } from "node:path";

/**
 * `npm run benchmark`: measures, from this device, how long each step the bot
 * depends on really takes. Nothing is signed or sent. Results go to
 * data/benchmark.json so the report can quote measured numbers, not guesses.
 */
export interface Stat {
  n: number;
  errors: number;
  medianMs: number | null;
  p90Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
}

export function summarize(ms: number[], errors = 0): Stat {
  if (!ms.length) return { n: 0, errors, medianMs: null, p90Ms: null, minMs: null, maxMs: null };
  const s = [...ms].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
  const mid = Math.floor(s.length / 2);
  return {
    n: s.length,
    errors,
    medianMs: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2,
    p90Ms: at(0.9),
    minMs: s[0],
    maxMs: s[s.length - 1],
  };
}

export interface BenchDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  rpcSlot: () => Promise<unknown>;
  rpcBlockhash: () => Promise<unknown>;
  /** Absent while the bot runs: it already uses the whole Jupiter limit. */
  quote?: (inputMint: string, outputMint: string, amount: bigint) => Promise<QuoteResponse>;
  /** Jito round trip (no sending); absent when not using Jito. */
  jitoTips?: () => Promise<unknown>;
  /** Subscribe to an account for `ms`; returns notifications seen and ms to the first one. */
  watchAccount?: (account: string, ms: number) => Promise<{ events: number; firstMs: number | null }>;
  /** Subscribe to new slots for `ms` (WebSocket health check). */
  watchSlots?: (ms: number) => Promise<{ events: number; firstMs: number | null }>;
}

export interface BenchOptions {
  rpcSamples: number;
  quoteSamples: number;
  /** Spacing between Jupiter requests (stay inside the rate limit). */
  jupiterGapMs: number;
  watchMs: number;
  /** USDC amount for test quotes (atoms). */
  amountAtoms: bigint;
}

export interface BenchResult {
  ts: number;
  rpcSlot: Stat;
  rpcBlockhash: Stat;
  quoteLeg?: Stat;
  quoteRoundTrip?: Stat;
  jito?: Stat;
  pool?: { account: string; seconds: number; events: number; perMin: number; firstMs: number | null };
  /** Slot notifications per second over the WebSocket (~2.5 when healthy). */
  slotsPerSec?: number;
  /** Shortest time a gap must survive for the bot to act on it (quote all legs + fresh re-quote). */
  minGapLifetimeMs: number | null;
}

async function sample(n: number, fn: () => Promise<unknown>, now: () => number, sleep: (ms: number) => Promise<void>, gapMs = 0) {
  const ms: number[] = [];
  let errors = 0;
  for (let i = 0; i < n; i++) {
    if (i && gapMs) await sleep(gapMs);
    const t0 = now();
    try {
      await fn();
      ms.push(now() - t0);
    } catch {
      errors += 1;
    }
  }
  return summarize(ms, errors);
}

export async function runBenchmark(d: BenchDeps, o: BenchOptions, progress: (line: string) => void = () => {}): Promise<BenchResult> {
  const say = (name: string, s: Stat) =>
    progress(
      `${name.padEnd(30)} ` +
        (s.medianMs === null ? "FAILED" : `median ${Math.round(s.medianMs)} ms, p90 ${Math.round(s.p90Ms!)} ms`) +
        `  (n=${s.n}${s.errors ? `, ${s.errors} errors` : ""})`,
    );
  const rpcSlot = await sample(o.rpcSamples, d.rpcSlot, d.now, d.sleep);
  say("RPC getSlot", rpcSlot);
  const rpcBlockhash = await sample(Math.max(1, Math.ceil(o.rpcSamples / 2)), d.rpcBlockhash, d.now, d.sleep);
  say("RPC getLatestBlockhash", rpcBlockhash);

  let lastQuote: QuoteResponse | undefined;
  let quoteLeg: Stat | undefined;
  let quoteRoundTrip: Stat | undefined;
  const quote = d.quote;
  if (quote) {
    quoteLeg = await sample(
      o.quoteSamples,
      async () => (lastQuote = await quote(USDC_MINT, SOL_MINT, o.amountAtoms)),
      d.now,
      d.sleep,
      o.jupiterGapMs,
    );
    say("Jupiter quote (one leg)", quoteLeg);
    // A full round trip: buy, then sell exactly what was bought, back to back (what a scan does).
    await d.sleep(o.jupiterGapMs);
    quoteRoundTrip = await sample(
      Math.max(1, Math.ceil(o.quoteSamples / 2)),
      async () => {
        const buy = await quote(USDC_MINT, SOL_MINT, o.amountAtoms);
        await quote(SOL_MINT, USDC_MINT, BigInt(buy.outAmount));
      },
      d.now,
      d.sleep,
      o.jupiterGapMs * 2,
    );
    say("Jupiter round trip (2 legs)", quoteRoundTrip);
  } else {
    progress(`${"Jupiter".padEnd(30)} skipped: the bot is running and uses the whole request limit (it times its own quotes: see npm run status)`);
  }

  let jito: Stat | undefined;
  if (d.jitoTips) {
    jito = await sample(3, d.jitoTips, d.now, d.sleep);
    say("Jito block engine", jito);
  }

  let slotsPerSec: number | undefined;
  if (d.watchSlots) {
    try {
      const w = await d.watchSlots(5_000);
      slotsPerSec = w.events / 5;
      progress(
        `${"WebSocket (new blocks)".padEnd(30)} ${slotsPerSec.toFixed(1)}/s` +
          (w.firstMs !== null ? `, first after ${w.firstMs} ms` : " (none: the WebSocket may be blocked)"),
      );
    } catch (err) {
      progress(`${"WebSocket (new blocks)".padEnd(30)} FAILED: ${String(err).slice(0, 100)}`);
    }
  }

  let pool: BenchResult["pool"];
  const account = lastQuote?.routePlan[0]?.swapInfo.ammKey;
  if (d.watchAccount && account) {
    progress(`Watching the SOL/USDC pool Jupiter routed through, for ${Math.round(o.watchMs / 1000)}s...`);
    try {
      const w = await d.watchAccount(account, o.watchMs);
      pool = { account, seconds: o.watchMs / 1000, events: w.events, perMin: (w.events / o.watchMs) * 60_000, firstMs: w.firstMs };
      progress(`${"Pool updates (WebSocket)".padEnd(30)} ${w.events} in ${pool.seconds}s (~${pool.perMin.toFixed(0)}/min)`);
    } catch (err) {
      progress(`${"Pool updates (WebSocket)".padEnd(30)} FAILED: ${String(err).slice(0, 100)}`);
    }
  }

  const minGapLifetimeMs = quoteRoundTrip?.medianMs == null ? null : quoteRoundTrip.medianMs * 2;
  return { ts: d.now(), rpcSlot, rpcBlockhash, quoteLeg, quoteRoundTrip, jito, pool, slotsPerSec, minGapLifetimeMs };
}

/** Plain-language reading of the numbers. */
export function explain(r: BenchResult): string[] {
  const out: string[] = [];
  if (r.minGapLifetimeMs !== null) {
    out.push(
      `A gap must last at least ~${Math.round(r.minGapLifetimeMs)} ms for this bot to even confirm it ` +
        `(a 2-leg quote, then a fresh re-quote), before building, simulating and sending.`,
    );
    out.push("Solana makes a block every ~400 ms; professional bots act within the same block, so gaps that close faster than that are out of reach.");
  }
  if (r.pool) {
    out.push(
      r.pool.events === 0
        ? `No updates arrived for the SOL/USDC pool in ${r.pool.seconds}s: it was quiet, or the WebSocket is blocked (then event triggers can't work here; EVENT_TRIGGERS=off saves the connection).`
        : r.pool.perMin > 30
          ? `The SOL/USDC pool changed ~${r.pool.perMin.toFixed(0)} times a minute: too busy to be a useful trigger (the bot rests pools like this).`
          : `The SOL/USDC pool changed ~${r.pool.perMin.toFixed(0)} times a minute.`,
    );
  }
  if (r.slotsPerSec !== undefined && r.slotsPerSec < 1) {
    out.push("The WebSocket delivered few or no new-block notices: event triggers will not work well over this connection.");
  }
  return out;
}

async function main() {
  installConsoleRedaction();
  const cfg = loadConfig();
  const http = timeoutFetch();
  const conn = new Connection(cfg.rpcUrl, { commitment: "confirmed", fetch: http, wsEndpoint: cfg.rpcWsUrl });
  const jup = new JupiterClient(cfg.jupiterApi, http, cfg.jupiterApiKey);
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const live = readStatus(join(cfg.dataDir, "status.json"));
  const botRunning = !!live && live.state !== "stopped" && isAlive(live.pid);
  console.log("Measuring latency from this device. Nothing is signed or sent; this takes about a minute.\n");
  const result = await runBenchmark(
    {
      now: Date.now,
      sleep,
      rpcSlot: () => conn.getSlot(),
      rpcBlockhash: () => conn.getLatestBlockhash(),
      quote: botRunning ? undefined : (inputMint, outputMint, amount) => jup.quote({ inputMint, outputMint, amount, slippageBps: 50 }),
      jitoTips: cfg.sendVia === "jito" || isRealMoney(cfg.mode) ? () => new JitoClient(cfg.jitoUrl, http).getTipAccounts() : undefined,
      watchAccount: async (account, ms) => {
        const started = Date.now();
        let events = 0;
        let firstMs: number | null = null;
        const id = conn.onAccountChange(new PublicKey(account), () => {
          events += 1;
          if (firstMs === null) firstMs = Date.now() - started;
        }, { commitment: "processed" });
        await sleep(ms);
        await conn.removeAccountChangeListener(id);
        return { events, firstMs };
      },
      watchSlots: async (ms) => {
        const started = Date.now();
        let events = 0;
        let firstMs: number | null = null;
        const id = conn.onSlotChange(() => {
          events += 1;
          if (firstMs === null) firstMs = Date.now() - started;
        });
        await sleep(ms);
        await conn.removeSlotChangeListener(id);
        return { events, firstMs };
      },
    },
    {
      rpcSamples: 10,
      quoteSamples: 6,
      // Twice the bot's own spacing, so a running bot and the benchmark together stay under the limit.
      jupiterGapMs: jupiterMsPerRequest(cfg.jupiterRpm) * 2,
      watchMs: 20_000,
      amountAtoms: 20_000_000n,
    },
    (line) => console.log(line),
  );
  console.log("");
  for (const line of explain(result)) console.log(`- ${line}`);
  const path = join(cfg.dataDir, "benchmark.json");
  writeJsonAtomic(path, result, { pretty: true });
  console.log(`\nSaved to ${path} (npm run report shows it).`);
  process.exit(0);
}

if (process.argv[1]?.endsWith("benchmark.ts")) {
  main().catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
