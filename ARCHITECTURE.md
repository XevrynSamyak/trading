# Architecture (V2)

One Node/TypeScript process (the **engine**) runs the trading loop. Every
screen (`status`, `watch`, `report`, `backtest`, the optional status page)
only reads the files the engine writes, so they can run on the phone or, via
the status server, on another device.

```
 .env ──▶ config.ts ──▶ index.ts (main loop) ─────────────────────────────────────────────┐
                         │                                                                │
  Helius WebSocket ──▶ poolwatch.ts  ── pool changed → token "dirty", wake the loop       │
  (route pools)          │                                                                │
                         ▼                                                                │
  kill switch? ─▶ risk.check ─▶ tokensafety.ts ─▶ pick: dirty tokens │ brain.pickTokens │ triangles
                         │                                                                │
                         ▼                                                                │
  scanner.ts: quote every leg (cycle.ts) through budget.ts (60 s + 10 s windows,         │
              keeping room to execute), value after costs (costs.ts), stop at the first   │
              gap worth acting on                                                         │
                         ▼                                                                │
  rank by EV (stats.ts: Bayesian success rates) ─▶ size ladder (sizer.ts, free budget)   │
                         ▼                                                                │
  executor.ts: fresh re-quote of every leg + on-chain floor                               │
     paper quote-only │ paper simulate (public key) │ micro/live: simulate, sign, Jito      │
                         ▼                                                                │
  funnel.ts (opps-<mode>.jsonl) · ledger.ts (trades-<mode>.jsonl) · brain.ts · status.json┘
```

## Modules

| File | Role |
|---|---|
| `index.ts` | Main loop: scheduling, bookkeeping, risk, scanning, execution, status. |
| `config.ts` | All settings from `.env`, with validation; modes `paper`/`micro`/`live`. |
| `secrets.ts`, `log.ts` | Startup secret checks (seed phrases, keys in the wrong slot); redaction of every printed line. |
| `jupiter.ts` | Jupiter quote and swap-instructions client (`x-api-key` header). |
| `budget.ts` | Sliding-window request counter (60 s and 10 s windows). |
| `http.ts` | Fetch with a 15 s timeout for every service. |
| `cycle.ts` | Cycle specs (two-leg, triangle) and quoting every leg back to back. |
| `triangles.ts` | Triangles through a pivot (SOL) and their rotation. |
| `costs.ts` | Cost model: base fee, priority fee, dynamic Jito tip, safety buffer. |
| `scanner.ts` | Quotes cycles one after another, values them, stops early on a candidate. |
| `stats.ts` | Learning engine V2: Bayesian success rates per stage, token and route; EV; score. |
| `sizer.ts` | Size ladder: which sizes to try, best expected value. |
| `executor.ts` | Fresh re-quote, floor, one-transaction build, simulate, send, landing. |
| `jito.ts` | Jito block engine client (`bundleOnly` single-transaction bundles). |
| `funnel.ts` | Opportunity IDs and one structured record per acted-on candidate. |
| `ledger.ts` | Trade log with a basis on every amount: quoted, simulated, realized. |
| `brain.ts` | Older EWMA learner: pacing, focus/hot tokens, size buckets, haircut, thoughts. |
| `risk.ts`, `killswitch.ts`, `gate.ts` | Loss guards, emergency stop, go-live gate. |
| `tokensafety.ts`, `discovery.ts` | Token states from mint accounts and Jupiter's token list. |
| `poolwatch.ts` | WebSocket pool subscriptions with caps (event triggers). |
| `status.ts`, `status-file.ts`, `server.ts` | Status screen data/rendering, `status.json`, optional HTTP status page. |
| `report.ts`, `report-cli.ts`, `backtest.ts`, `benchmark.ts`, `check.ts` | The other commands. |
| `atomic.ts`, `tail.ts` | Crash-safe JSON writes, reading the end of a file. |

## Files in `data/`

| File | Written by | Contents |
|---|---|---|
| `opps-<mode>.jsonl` | engine | One line per acted-on opportunity: ID, quoted/executable/simulated/realized amounts, costs, ladder, stage reached, timestamps, latency. **The source of truth for learning** (replayed at startup). |
| `trades-<mode>.jsonl` | engine | One line per attempt with its basis (quoted/simulated/realized). |
| `brain-<mode>.json` (+ `.bak`) | engine | EWMA learner state; written atomically with a backup. |
| `token-safety.json` (+ `.bak`) | engine, `check` | Mint facts and market facts per token. |
| `status.json` | engine | Live snapshot for the status screens. |
| `benchmark.json` | `benchmark` | Last latency measurement. |
| `TRADING_DISABLED` | `stop-trading`, engine, status page | Kill switch; only `enable-trading` removes it. |
| `HALTED` | engine | Loss floor or retirement; delete by hand after reading. |
| `bot.log`, `run.pid` | `deploy/termux-run.sh` | Log (redacted) and the single-instance lock. |

## Process model

`deploy/termux-run.sh` keeps one engine running on the phone: a pid lock,
a wake lock, restart 30 s after a crash, no restart after a clean stop
(exit 0) or a refused start (exit 2: bad settings, LIVE gate not passed),
and no start while `data/HALTED` exists.

## The scarce resource

Everything competes for Jupiter's request budget (60/min with a free key;
the bot also keeps any 10 s to a sixth of that). Hence: quotes are spent
where markets move (event triggers, focus on hot tokens), scans stop at the
first gap worth acting on, each scan leaves room to execute immediately, and
the size ladder only uses requests that are free right now.

## Engine and dashboard split

`status.ts` separates gathering (plain JSON, `gatherStatus`) from rendering,
and `server.ts` serves that JSON. `npm run watch` shows either the local data
folder or a remote engine (`ENGINE_URL`, `ENGINE_TOKEN`). Moving the engine to
a server later needs no code change: copy `.env`, run `npm start` there, and
point `ENGINE_URL` at it.
