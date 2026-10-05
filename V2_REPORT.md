# V2 final report

Branch `claude/keen-ptolemy-y8ns0k`. Audit (AUDIT.md), then steps A–J, each
committed separately with its tests. At the end: **25 test files, 172 tests,
all passing** (79 at the audit).

**How this was verified, and its limits.** The development sandbox cannot
reach Jupiter, Helius, Solana or Jito. Everything was tested with unit tests
and with end-to-end runs of the real bot against local fake services: Jupiter
quotes, Solana RPC with mint and balance data, a WebSocket with pool updates.
Those runs prove the mechanisms work. **They say nothing about real markets.**
Every market number below is either from the earlier phone run (V1) or marked
"no data yet".

---

## 1. What was wrong (V1)

From the audit:
- **The strategy mostly measured noise.** A round trip through one aggregator
  is about −(fees + spread) when both quotes see the same market; most
  "gaps" were the market moving between the two quotes.
- **Leg 1 was seconds old when executed**, so latency turned into "fake gaps".
- **Quoted amounts were shown as profit** (e.g. "+$0.05", which was never
  real).
- No trade sizing, a fixed Jito tip, no expected-value weighting.
- **No latency was measured at all.**
- Robustness:
  - the brain file could be corrupted by a crash, resetting all learning;
  - API keys could leak into the log through error messages;
  - nothing checked for a secret key or seed phrase in the wrong setting.

Found and fixed during V2:
- **No network call had a timeout.** A hung request could freeze the bot for
  minutes.
- **A sent real transaction could be lost track of** in three ways:
  - a send that timed out was treated as refused, though it may have arrived;
  - an RPC error while waiting for the landing dropped the outcome without a
    record;
  - a landed trade whose result couldn't be read did the same.
- **Measured latency was wrong:** quote → decision showed −10 s. The real
  value was +10 s, because the bot finished the whole scan and then compared
  sizes, waiting for API room, before acting.
- **A found gap could wait about 6 s for API room** before its fresh re-quote.
- **Partial prefixes of your real Helius and Jupiter keys** were in a test
  file (since replaced; see "Your keys" below).
- **Introduced and fixed in V2:** with event triggers on, a stopped bot could
  stay alive, because the WebSocket client kept reconnecting.

## 2. What improved

| Step | What |
|---|---|
| A | Every amount labelled **quoted / simulated / realized**; quotes are never shown as profit. Crash-safe brain file with a backup. Log redaction. Startup secret checks (seed phrases, keys in the wrong slot, mismatched keys). |
| B | Every leg **re-quoted fresh** right before building; any number of legs in one transaction; a cost model with a dynamic Jito tip (share of profit, capped) and a safety buffer; the failing leg identified. |
| C | **Opportunity funnel**: an ID per opportunity and its furthest stage (quoted → executable → simulated → submitted → landed → profitable), with timestamps. Bayesian success rates per token and route; ranking by expected value. |
| D | **Size ladder**: compares sizes on candidates and picks the best expected value within every cap. |
| E | **PAPER / MICRO / LIVE**: MICRO caps each trade at $5. The **go-live gate** makes LIVE refuse to start without proven MICRO results. **Kill switch** (`npm run stop-trading`), tripped automatically by unexpected outcomes. Consecutive-loss cooldown. New `npm run report`. |
| F | **Token safety states** (BLOCKED / WATCH / PAPER_ONLY / LIVE_ALLOWED) from on-chain mint facts and market data. Discovered tokens never trade real money unless allowlisted. 15 s timeouts on all network calls. |
| G | **Event triggers**: re-quote a token when its pool changes (capped). Scans keep room to execute a found gap at once. `npm run benchmark`. |
| H | **Triangles** through SOL; `npm run backtest`. |
| I | Optional **status page** with an emergency stop (never a start); remote `npm run watch`. |
| J | `npm run check` upgrades. Clean exit on stop. Sent transactions never lost track of. Docs: ARCHITECTURE, EXECUTION, LEARNING, RISK, PROFITABILITY. |

## 3. Measured latency

**Real-network latency has not been measured yet**, because the sandbox
can't reach the services. To measure it on the phone:
- run `npm run benchmark` with the bot stopped;
- then run the bot: every opportunity records its stage timings, and
  `npm run report` shows the medians.

What was measured, against local fakes, is the bot's own overhead:

| Interval | Before | After |
|---|---|---|
| quote → decision (with sizing) | ~10,100 ms (shown as −10,095) | ~1–6 ms |
| decision → fresh re-quote | up to ~6,000 ms (waiting for API room) | ~2 ms |
| pool change → quote (event triggers) | n/a | ~4–6 ms |

Real numbers add the network: each Jupiter quote is likely a few hundred ms
from a phone, so a gap must last at least two quote round trips to be
confirmed, before build, simulation and landing. The benchmark measures this.

## 4–6. Average quoted, executable and realized edge

| Edge | Answer |
|---|---|
| Quoted | Only V1 phone data (about a day): **about 92 % of scans' best gap was below 0 bps; 0.6 % reached ≥ 10 bps** (after fees). |
| Executable (still there at the fresh re-quote) | **No data yet:** this stage exists since V2 and needs a phone run. |
| Simulated on-chain | **No data yet:** needs `WALLET_PUBLIC_KEY`. |
| Realized | **None:** no real trades. |

## 7. Landing rate

**No data**: no MICRO or LIVE trades. Until real trades exist, the learner
uses an explicit, labelled prior of 50 %.

## 8. Profitable rate

**No data.** The prior is 90 % of landed trades, because the on-chain floor
should make losses rare. Only real trades can confirm that.

## 9. Optimal size behaviour

The ladder works, but there is **no market data** on how profit changes with
size. With a $25 wallet the ladder can only span about $1–20. The backtest
compares size policies once data exists.

## 10. Maximum safe trade size

**Not established.** The current caps (paper uses 80 % of USDC on hand,
MICRO is hard-capped at $5) are settings, not findings. Keep MICRO at $1–5
until the report shows realized results.

## 11. Realized P&L

**$0.00.** No real trade has ever been made. Quoted amounts shown in the
past were never profit.

## 12. Is MICRO safe?

**Losses are tightly bounded:**
- at most $5 per trade, with an on-chain minimum output;
- trading stops on any loss above $0.05 or any unconfirmed landing;
- trading pauses after −$2 in a day and stops for good at a 30 % drawdown.

**But it is not recommended yet. The gate says MICRO: NO** (no on-chain
simulated trades, less than 3 days of paper data). First run paper mode with
`WALLET_PUBLIC_KEY` until `npm run report` says `MICRO LIVE: YES`.

## 13. Is FULL LIVE justified?

**No.** The bot refuses to start LIVE until at least 20 MICRO trades landed,
70 % or more were profitable, realized P&L is positive, and no landing went
unconfirmed.

## 14. What blocks profitability

1. **Design vs competition:** professional bots read pool state directly and
   land in the same ~400 ms block. A phone using HTTP quotes only sees gaps
   that last much longer, and those are rare.
2. **Request budget:** 60 quotes a minute with a free key. Keeping room to
   execute at once leaves about 6 full scans a minute (quote-only paper) or
   about 4 (on-chain testing or real trading).
3. **Capital:** at $20–25 per trade, even a real 0.5 % edge pays about $0.10.
   $20–30 per trade would need about $2,000–6,000 per trade at a realized
   0.5–1 % edge, and nothing measured supports edges like that.
4. **Unknowns** only MICRO can measure: landing rate, competition for Jito
   inclusion, real costs.

## 15. What next

1. **Update the phone:**
   ```bash
   pkill -f termux-run.sh; pkill -f src/index.ts
   cd ~/trading && git pull && npm ci
   ```
2. **Rotate keys:**
   - get a new Helius key (the old one was pasted in chat);
   - get a new Jupiter key;
   - put both in `.env` only.
3. `npm run check`, then `npm run benchmark` (with the bot stopped).
4. **Realistic paper testing:**
   - create a fresh Phantom account just for the bot and fund it with
     about $20 USDC + $3 SOL;
   - put **only its public address** in `WALLET_PUBLIC_KEY`;
   - start the bot: `bash deploy/termux-run.sh &`.
5. **Let it run for 3+ days**, then read `npm run report` (funnel, "still
   there at re-quote", simulated edge, go-live verdict) and `npm run backtest`
   (how fast gaps die).
6. **Only if the report says `MICRO LIVE: YES`:**
   - set `MODE=micro`, `LIVE_TRADING_CONFIRM=yes` and
     `PRIVATE_SIGNING_KEY` (that wallet's secret key, typed into `.env` on
     the phone, never pasted anywhere);
   - watch the first trades.
7. **If after days almost nothing survives the fresh re-quote,** the honest
   conclusion is that this design can't compete from a phone. The next step
   would be a different design (direct pool-state reading, or a server near
   the validators). Both are large projects, worth starting only with
   evidence. Adding capital or risk would not fix it.

## Your keys

Partial prefixes of your Helius and Jupiter keys were committed in a test
file in step A (commit `3be3a4d`). They are replaced with fake values now,
but they remain in the branch's git history. The other halves were never in
the repo. **Rotating both keys** makes the old ones useless; that is the
simplest complete fix. The history can also be rewritten (force push) if you
want.
