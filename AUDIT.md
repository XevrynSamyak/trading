# Audit: Solana arbitrage bot (V1)

Audited at commit `a9e42e4` on 2026-10-05. Nothing was changed during the audit.
Test suite at audit time: **14 files, 79 tests, all passing** (`npm test`).

Everything below comes from reading the code and running the tests. Where a
behaviour has **not** been observed against the real network (live sends, Jito
landing, on-chain simulation results), that is stated explicitly.

---

## 1. Current architecture

```
                         ┌──────────────── src/index.ts (main loop, ~386 lines) ────────────────┐
 .env ─▶ config.ts ─────▶│ every cycle (polling, ~7–9 full scans/min):                           │
                         │  1. bookkeeping: SOL price (5 min), token discovery (6 h), daily/month │
                         │  2. wallet value: paper = start + Σ ledger; live/on-chain = Helius     │
                         │     balances (cached 60 s)                                              │
                         │  3. risk.check(): loss floor, daily loss, failure cooldown             │
                         │  4. brain.pickTokens(): 3 tokens (or 1–2 "focus" tokens)              │
                         │  5. scanner.scan(): per token, Jupiter quote USDC→X then X→USDC       │
                         │     (sequential, paced by budget.ts sliding windows 60 s + 10 s)       │
                         │  6. brain ranks by quote − learned "haircut"; shouldAttempt()          │
                         │  7. executor: paper (quote) │ simulate (on-chain, public key) │ live   │
                         │  8. ledger.append (JSONL), brain.observe*, status.json, notify        │
                         └────────────────────────────────────────────────────────────────────────┘
```

| Area | File(s) | How it works today |
|---|---|---|
| Market data | `jupiter.ts`, `scanner.ts` | HTTP polling of Jupiter `/quote`. No pool/account data, no WebSocket. |
| Quotes | `jupiter.ts` | `restrictIntermediateTokens=true`, `maxAccounts=28` per leg, `slippageBps=0` while scanning. |
| Arbitrage detection | `scanner.ts`, `profit.ts` | Two-leg round trip USDC→X→USDC through Jupiter's best route each way. Net = out − in − (base fee + priority + Jito tip) in USD. |
| Token discovery | `discovery.ts` | Jupiter `tokens/v2/toptraded/1h`, keeps `isVerified` + liquidity ≥ $1M, max 12 tokens, prunes useless finds. |
| Learning | `brain.ts` (602 lines) | EWMA per token: edge, size bucket (25/50/100 %), hour of day, "haircut" (quote vs on-chain), phantoms, hot tokens, pace. Persisted to `data/brain-*.json`. |
| Transaction build | `executor.ts` `buildArbTx` | Re-quotes **leg 2 only** with a slippage floor = in + fees + min profit; fetches both legs' swap instructions; one v0 tx: compute budget, leg 1, leg 2, cleanup, Jito tip. |
| Simulation | `executor.ts` `simulateExecute` | `simulateTransaction` with `sigVerify:false`, reads USDC account after. Needs only a public key. |
| Jito | `jito.ts`, `executor.ts` `liveExecute` | `sendTransaction` to `/transactions?bundleOnly=true` (single-tx bundle). Fixed tip `JITO_TIP_LAMPORTS` (10 000). Tip accounts from `getTipAccounts`. |
| Risk | `risk.ts`, `index.ts`, `sustain.ts` | Loss floor (halt + `data/HALTED`), daily loss pause, 5-failure cooldown, monthly bills check. |
| Persistence | `ledger.ts`, `brain.ts`, `status-file.ts` | JSONL trade log; brain JSON; status JSON (atomic write). |
| Config | `config.ts` | `.env` via dotenv; live needs `MODE=live` **and** `LIVE_TRADING_CONFIRM=yes` **and** `WALLET_SECRET_KEY`. |
| Logging | `console.*`, `notify.ts` (Telegram) | Free-text lines into `data/bot.log` (via `termux-run.sh`). No IDs, no timestamps on most lines. |
| UI | `status.ts`, `report-cli.ts`, `check.ts` | `npm run watch/status/report/check`. |

---

## 2. Strengths (keep these)

1. **Atomic round trip.** Both legs are in one transaction with an on-chain
   minimum output on leg 2, so the bot can never be left holding a token
   halfway. This also limits token risk: a bad token makes the transaction
   revert instead of losing money.
2. **Live trading is hard to switch on by accident.** It takes three
   independent settings, and a typo in `MODE` falls back to paper.
3. **On-chain simulation needs no secret key.** It's a realistic test with
   zero exposure.
4. **Rate-limit discipline.** A two-window budget (60 s and 10 s) is measured
   against a strict fake Jupiter: zero 429s.
5. **Separation of quote-only and verified results** exists in the ledger
   (`verified` flag), and the go-live verdict already ignores quote-only wins.
6. **Decent tests** for profit math, budget, brain, executor (with fakes), risk,
   status, config.

---

## 3. Critical findings

Severity: 🔴 blocks profitability or correctness · 🟠 important · 🟡 minor

### 3.1 Profitability blockers

🔴 **P1. The strategy mostly measures noise, not executable arbitrage.**
Jupiter already routes each direction through the best venue it knows. So a
round trip USDC→X→USDC through Jupiter is, by construction, about
−(DEX fees + spread) whenever both quotes see the same market state. The
positive "gaps" the bot finds (0.6 % of scans ≥ 5 bps on the phone) mostly
come from:
- the market moving between the leg-1 and leg-2 quotes (they are fetched
  sequentially, roughly 0.3–1 s apart);
- Jupiter's cached or approximate routing;
- the `maxAccounts=28` restriction making one leg's route worse than the
  other's.

Real cross-venue gaps exist, but searchers that read pool state directly and
land in the same slot take them within milliseconds. **Expected executable
edge on the current design: close to zero.** That's a hypothesis to measure
(section 6), not a proven fact.

🔴 **P2. Leg 1 is stale when it is executed.** `buildArbTx` re-quotes leg 2
but reuses the **original leg-1 quote** with `slippageBps=0`. By the time the
transaction is built it has been through scan time, a re-quote, two
swap-instruction calls, lookup tables and a blockhash, roughly 1–3 s on a
phone. Any adverse tick makes leg 1's exact minimum fail, so the transaction
reverts. The fake-gap detector then counts these as "fake gaps", mixing up
"the gap wasn't real" with "our own latency killed it". Fix: re-quote **both**
legs together right before building, and record which leg failed.

🔴 **P3. Quoted profit is shown as profit.** In quote-only paper mode
`paperExecute` records the quoted net as a `filled` trade. `npm run
watch`/`status` show it under "Results … trades … +$0.0535", and the paper
wallet value includes it. The verdict already ignores it, but the screens
present it as profit. Every place that shows money must label it as one of:
quoted, simulated, expected or realized.

🟠 **P4. No size optimisation.** Each scan quotes one size per token (25/50/100 %
of the wallet, learned slowly). The profit-vs-size curve is never evaluated.
Within a 60 requests/min budget, a size ladder must be a **second stage** that
only runs on candidates (each size costs 2 requests).

🟠 **P5. Static cost model.**
- The Jito tip is fixed at 10 000 lamports (~$0.0012), almost certainly below
  competitive tips. Landing probability is unknown and not modelled.
- There is no safety buffer and no expected-value weighting (profit ×
  probability).
- DEX fees and price impact *are* included, implicitly, in Jupiter's
  `outAmount`. That's good, but it's only true for the size that was quoted.

🟠 **P6. Capital vs edge.** The wallet is about $25 and trade size about $20. Even a real
0.5 % net edge pays about $0.10 a trade. The $20–30-per-trade target needs about
$2–4k of capital at 0.5–1 % *realized* edge. Nothing measured so far supports
adding capital.

### 3.2 Correctness, robustness, race conditions

🟠 **C1. Brain file write isn't atomic** (`brain.ts:201`, `writeFileSync` every
cycle). A crash or power loss mid-write leaves invalid JSON, so `load()` returns
null and **all learning silently resets**. Fix: write to a temp file and rename (as
`status-file.ts` already does), and keep a backup copy.

🟠 **C2. `ledger.all()` reads the whole JSONL file every cycle** (`index.ts:201`).
That's fine today, but it grows with time. Fix: keep running totals in memory.

🟠 **C3. Quote freshness isn't tracked.** Jupiter returns `contextSlot` and
timing; the bot ignores them and records no timestamps. Stale-quote detection
isn't possible yet.

🟡 **C4. Live P&L is measured by balance difference** (USDC before/after). That's
correct for one bot per wallet, wrong if anything else moves USDC. The
documentation says to use a dedicated wallet.

🟡 **C5. `waitForLanding` polls** `getSignatureStatuses` plus `getBlockHeight`
every second for up to ~60 s. That's OK for now and could use a WebSocket
`signatureSubscribe`.

🟡 **C6. A single process means no internal races.** Two instances are prevented
by the pid lock in `termux-run.sh` (`npm start` directly bypasses it).

### 3.3 Latency (not measured; estimates from code structure)

| Step | Today | Note |
|---|---|---|
| Market change → noticed | 0–7 s (polling interval) | No market events at all |
| Quote (2 requests per token, sequential) | ~0.3–1.5 s per token from a phone (est.) | Not measured |
| Decision | < 1 ms | |
| Build (re-quote + 2 × swap-instructions + lookup tables + blockhash) | ~1–3 s (est.) | Sequential HTTP calls |
| Simulate + send | ~0.3–1 s (est.) | |
| **Total market → submission** | **~2–10 s** | Professional searchers: under one slot (~400 ms) |

**None of this is measured.** Phase 4 must add timestamps before any
optimisation claims.

### 3.4 Dangerous assumptions in docs or code

🟠 **D1. "Failed attempts cost nothing (Jito)."** This holds only for
`bundleOnly` revert protection *when it works as documented*, which hasn't been
observed live. A tip is paid only if the transaction lands, but a landed
transaction can still lose if the floor was computed with a stale SOL price,
because the floor uses the cached 5-minute SOL price for fees. Opportunity cost
and competition are not modelled. The README wording should be softened.

🟡 **D2. "Guarantees profit."** The on-chain floor guarantees
`leg2 out ≥ in + estimated fees + min profit`, not realized profit.
`leg2 out` covers the USDC side only, while the fees are paid in SOL at an
estimated price.

🟡 **D3. Token discovery trusts `isVerified` and liquidity.** Atomicity limits
the damage (the bot can't get stuck holding a token), but Token-2022 transfer
fees or hooks could make quotes wrong. Mint and freeze authority aren't
checked.

### 3.5 Security

🟠 **S1. Error objects are logged in full** (`console.error("cycle error:", err)`).
Library errors could include request URLs. The **Helius key is in the RPC URL**,
so it could end up in `data/bot.log`. Fix: one log function that removes
`api-key=…`, base58 strings of secret-key length (87–88 characters), and
`x-api-key`.

🟠 **S2. API keys were pasted into this chat.** The Helius key
(`…b433`) is still in use. The first Jupiter key was replaced. **Recommend
rotating the Helius key.**

🟡 **S3. Mixing up public and secret keys.** A secret key in
`WALLET_PUBLIC_KEY` currently produces a `PublicKey` error. There's no explicit
check that says "this looks like a secret key, remove it". A startup check
should detect: a secret key in a public slot, a seed phrase (12/24 words) in any
value, `.env` readable by others, and secrets present while in paper mode.

✅ `.env` and `data/` are git-ignored. The Jupiter key goes in a header, never
in a URL. `npm run check` masks the RPC key. The secret key is only decoded,
never printed. **Live mode can't switch on accidentally:** it needs 3 explicit
settings.

---

## 4. Duplicated logic and bottlenecks

- Wallet value is computed in two places (`index.ts` paper/live branches,
  `check.ts`). It should be a single `Portfolio` function.
- Fee estimates appear in `profit.ts` (`evaluateRoundTrip`) and again in
  `executor.ts` (`simulateExecute`). One `CostModel` should own them.
- The main loop (`index.ts`) mixes scheduling, bookkeeping, risk, execution and
  status. That makes "run the engine on a server, show the dashboard on the
  phone" hard.
- **Main bottleneck:** the Jupiter request budget (60/min with the free key).
  Every new feature competes for it: size ladders, triangles, re-quoting both
  legs. So **spending requests only where the market changes** matters more
  than raw speed.

---

## 5. Recommended architecture (V2)

```
        events (Helius WebSocket: pool accounts from Jupiter routePlan.ammKey)
                │  change on a watched pool
                ▼
  ┌─────────── Engine (portable: Termux today, server later) ───────────┐
  │ MarketWatch ─▶ OpportunityEngine ─▶ Sizer ─▶ CostModel ─▶ Scorer      │
  │   (events +      (2-leg now;       (size ladder   (fees, impact,     │
  │    slow poll)     triangle later)   on candidates)  tip, buffer)      │
  │        │                                                      │      │
  │        └──────────── Funnel recorder (opportunity ID, every stage, ──┤
  │                       timestamps, costs, outcome) ─▶ data/opps.jsonl │
  │ Executor: PAPER │ SIMULATE │ MICRO │ LIVE  ── RiskGate (kill switch) │
  └──────────────────────────────────────────────────────────────────────┘
                │ status.json / opps.jsonl
                ▼
  Dashboard (phone): watch, report, check, controls
```

Key ideas:
- **Event-triggered re-quotes, not faster polling.** Jupiter quotes include the
  pool accounts (`routePlan[].swapInfo.ammKey`). Subscribe to those accounts on
  Helius (free WebSocket) and re-quote a token only when one of its pools
  changes. That's realistic on the current setup and spends the 60/min budget
  where prices move. Writing our own Raydium/Orca/Meteora pool maths would be
  the step after that; it's a large job and only justified if the data
  supports it.
- **A funnel with one opportunity ID** at every stage (quote, executable re-quote,
  simulation, submission, landed, profitable), plus latency timestamps. This is
  what answers "does it make money".
- **A size ladder only on candidates** (see P4).
- **MICRO mode** as an explicit mode: real transactions, hard cap of $1–5,
  automatic halt on any unexpected result.

---

## 6. Prioritised plan

Each step is incremental, tested, and keeps paper mode safe. No step switches
on real trading.

| # | Step | Phases | Why first |
|---|---|---|---|
| **0** | **Honesty and safety fixes:** label quoted, simulated, expected and realized amounts everywhere; atomic brain save and backup; log redaction; secret-misuse startup checks; soften README claims | 2, 13, 18 | Cheap, removes misleading numbers and real risks |
| **1** | **Funnel and observability:** opportunity IDs, a structured `opps.jsonl`, latency timestamps, per-token quoted/simulated/realized statistics in `report` | 4 (measure), 9, 20, 15 | Without it nothing else can be judged |
| **2** | **Fix stale leg 1:** re-quote both legs together before build; record which leg fails; compare our latency vs the gap's lifetime | 2, 9 | Removes a self-inflicted "fake gap" source |
| **3** | **Cost model and EV:** one `CostModel` (base, priority, tip, buffer); dynamic tip as a capped % of expected profit; EV = profit × P(success) with Bayesian (Beta) success rates per token and route | 2, 7, 8, 10, 12 | Correct go/no-go decisions |
| **4** | **Size ladder** on candidates (configurable sizes, capped by balance, impact and liquidity); pick argmax EV | 5, 6 | Real profit per opportunity |
| **5** | **MICRO mode and the new go-live verdict:** PAPER, MICRO ($1–5 hard cap), LIVE gated by a minimum count of landed, profitable MICRO trades | 14, 15 | First real execution data |
| **6** | **Token safety score:** mint/freeze authority, Token-2022 extensions, liquidity; BLOCKED, WATCH, PAPER_ONLY, LIVE_ALLOWED | 11 | Before any live trading on discovered tokens |
| **7** | **Event-triggered re-quotes** via Helius WebSocket on route pools; slow polling as fallback | 4, 17 | Speed where it matters, after measuring |
| **8** | **Triangular cycles** (USDC→A→B→USDC) as a second strategy, only on liquid pairs and only if the budget allows | 3 | Expensive in requests; only after 1–7 show what's real |
| **9** | **Engine and dashboard split**, so the engine can move to a server unchanged | 16 | When/if data justifies a server |

Deliberately **not** planned now:
- our own DEX pool maths;
- an ML model;
- a forced server move;
- any automatic switch to live.

---

## 7. Answers available today (before V2)

| Question | Answer now |
|---|---|
| Latency (scan, decision, execution) | **Not measured.** Estimate 2–10 s market → submission (section 3.3). |
| Average quoted edge | Best scan per cycle: about 92 % below 0 bps, 0.6 % ≥ 10 bps (phone, ~1 day) |
| Average executable (simulated) edge | **No data:** on-chain simulation isn't enabled (`WALLET_PUBLIC_KEY` not set) |
| Realized edge, landing rate, profitable % | **No data:** no live or MICRO trades |
| Realized P&L | **$0.00.** The +$0.05 shown is *quoted*, not realized. |
| Optimal size behaviour | Not evaluated (single size per scan) |
| Max safe trade size | Unknown until executable-edge data exists; today capped by the $25 wallet |
| MICRO safe to test? | **Not yet:** first fix P2 (stale leg 1) and run on-chain simulation for 2–3 days |
| FULL LIVE justified? | **No** |
| What prevents profitability | P1 (design measures noise and competes with same-slot searchers), P2, P6 |
