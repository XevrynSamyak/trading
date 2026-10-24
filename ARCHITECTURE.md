# Architecture (V2)

One Python process (the **engine**, `python3 -m arbbot start`) runs the trading loop on asyncio. Every
screen (`status`, `watch`, `report`, `backtest`, the optional status page)
only reads the files the engine writes, so they can run on the phone or, via
the status server, on another device.

```
 .env ──▶ config.py ──▶ engine.py (main loop) ────────────────────────────────────────────┐
                         │                                                                │
  Helius WebSocket ──▶ poolwatch.py  ── pool changed → token "dirty", wake the loop       │
  (route pools)          │                                                                │
                         ▼                                                                │
  kill switch? ─▶ risk.check ─▶ tokensafety.py ─▶ pick: dirty tokens │ brain.pick_tokens │ triangles
                         │                                                                │
                         ▼                                                                │
  scanner.py: quote every leg (cycle.py) through budget.py (60 s + 10 s windows,         │
              keeping room to execute), value after costs (costs.py), stop at the first   │
              gap worth acting on                                                         │
                         ▼                                                                │
  rank by EV (stats.py: Bayesian success rates) ─▶ size ladder (sizer.py, free budget)   │
                         ▼                                                                │
  executor.py: fresh re-quote of every leg + on-chain floor                               │
     paper quote-only │ paper simulate (public key) │ micro/live: simulate, sign, Jito      │
                         ▼                                                                │
  funnel.py (opps-<mode>.jsonl) · ledger.py (trades-<mode>.jsonl) · brain.py · status.json┘
```

## Modules

All modules live in `arbbot/`.

| File | Role |
|---|---|
| `__main__.py` | The commands: `python3 -m arbbot start/paper/micro/check/status/watch/report/backtest/benchmark/stop-trading/enable-trading`. |
| `engine.py` | Main loop: scheduling, bookkeeping, risk, scanning, execution, status, watchdog. |
| `config.py` | All settings from `.env`, with validation; modes `paper`/`micro`/`live`. |
| `secret_checks.py`, `log.py` | Startup secret checks (seed phrases, keys in the wrong slot); redaction of every printed line. |
| `solana/` | Plain-Python Solana: base58, Ed25519 signing, keys and token-account addresses, v0 transactions with lookup tables (byte-identical to web3.js), JSON-RPC and WebSocket clients. |
| `jupiter.py` | Jupiter quote and swap-instructions client (`x-api-key` header). |
| `budget.py` | Sliding-window request counter (60 s and 10 s windows). |
| `http.py` | One shared HTTP client with a 15 s timeout for every service. |
| `cycle.py` | Cycle specs (two-leg, triangle) and quoting every leg back to back. |
| `triangles.py` | Triangles through a pivot (SOL) and their rotation. |
| `costs.py`, `profit.py` | Cost model: base fee, priority fee, dynamic Jito tip, safety buffer; the on-chain floor maths. |
| `scanner.py` | Quotes cycles one after another, values them, stops early on a candidate. |
| `stats.py` | Learning engine V2: Bayesian success rates per stage, token and route; EV; score. |
| `sizer.py` | Size ladder: which sizes to try, best expected value. |
| `executor.py` | Fresh re-quote, floor, one-transaction build, simulate, send, landing. |
| `jito.py` | Jito block engine client (`bundleOnly` single-transaction bundles). |
| `wallet.py` | Keypair loading, balances, the balance cache. |
| `funnel.py` | Opportunity IDs and one structured record per acted-on candidate. |
| `ledger.py` | Trade log with a basis on every amount: quoted, simulated, realized. |
| `brain.py` | Older EWMA learner: pacing, focus/hot tokens, size buckets, haircut, thoughts. |
| `probes.py` | Probes (paper re-checks of gaps below the bar) and the gap memory. |
| `risk.py`, `killswitch.py`, `gate.py`, `sustain.py` | Loss guards, emergency stop, go-live gate, "did it pay its bills". |
| `tokensafety.py`, `discovery.py` | Token states from mint accounts and Jupiter's token list. |
| `poolwatch.py` | WebSocket pool subscriptions with caps (event triggers). |
| `pricewatch.py` | Jupiter price API: every known token's price in one request, to spot movers. |
| `predict.py` | Prediction maths: online logistic and linear models, and the scorecard that tests every prediction before learning its outcome. |
| `gappredict.py` | Predicts whether a quoted gap will still be there at the re-check, and its size. |
| `trend.py` | Price-direction predictions from 1-minute prices, with paper trades only. |
| `status.py`, `status_file.py`, `server.py` | Status screen data/rendering, `status.json`, optional HTTP status page. |
| `report.py`, `backtest.py`, `benchmark.py`, `check.py`, `control.py`, `notify.py` | The other commands and Telegram alerts. |
| `atomic.py`, `jsonl.py`, `tail.py`, `util.py` | Crash-safe JSON writes, JSON-lines files, reading the end of a file, time helpers. |

Data files keep the field names (camelCase) of the earlier TypeScript version,
so a phone's existing `data/` folder carries over unchanged.

## Files in `data/`

| File | Written by | Contents |
|---|---|---|
| `opps-<mode>.jsonl` | engine | One line per acted-on opportunity: ID, quoted/executable/simulated/realized amounts, costs, ladder, stage reached, timestamps, latency. **The source of truth for learning** (replayed at startup). |
| `trades-<mode>.jsonl` | engine | One line per attempt with its basis (quoted/simulated/realized). |
| `brain-<mode>.json` (+ `.bak`) | engine | EWMA learner state; written atomically with a backup. |
| `token-safety.json` (+ `.bak`) | engine, `check` | Mint facts and market facts per token. |
| `status.json` | engine | Live snapshot for the status screens. |
| `benchmark.json` | `benchmark` | Last latency measurement. |
| `minutes.jsonl` | engine | 1-minute prices of every watched token (for price-direction predictions). |
| `trend.json` (+ `.bak`), `trend-paper.jsonl` | engine | Price-direction model, scorecard, open paper positions; closed paper trades. Paper only. |
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

`status.py` separates gathering (plain JSON, `gather_status`) from rendering,
and `server.py` serves that JSON. `npm run watch` shows either the local data
folder or a remote engine (`ENGINE_URL`, `ENGINE_TOKEN`). Moving the engine to
a server later needs no code change: copy `.env`, run `npm start` there, and
point `ENGINE_URL` at it.
