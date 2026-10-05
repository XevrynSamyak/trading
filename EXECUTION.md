# Execution

What happens from a quote to a landed transaction, and what each step can
cost.

## 1. Detect

A scan quotes each chosen cycle leg by leg (`cycle.ts`): leg 1 sells the
input, every next leg sells exactly what the previous one bought. Quotes use
0 slippage, `restrictIntermediateTokens`, and at most `floor(56 / legs)`
route accounts per leg so all legs fit in one v0 transaction.

Which cycles: tokens whose pool just changed (event triggers), otherwise the
brain's picks (hot and promising tokens first, plus exploration), and every
`TRIANGLE_EVERY`-th full scan, two triangles through SOL.

Before each cycle the scan waits until its quotes **and** an immediate
execution fit in the request budget (`budget.ts`), so a gap found is never
left waiting seconds for room. The scan stops at the first cycle worth
acting on.

## 2. Decide

Each cycle is valued after costs (`costs.ts`):

```
net = quoted out − in − (base fee + priority fee + Jito tip + safety buffer)
```

DEX fees and price impact are already inside Jupiter's quoted output for the
quoted size. The Jito tip is `JITO_TIP_SHARE` (25 %) of what is left after the
other costs, clamped to `[JITO_TIP_LAMPORTS, JITO_MAX_TIP_LAMPORTS]`. The
safety buffer is `SAFETY_BUFFER_BPS` of the size plus `SAFETY_BUFFER_USD`.

A cycle is acted on only if all of these hold:
- every token in it may be acted on in this mode (token safety);
- the brain's threshold: quoted net ≥ `MIN_PROFIT_BPS` after its learned
  haircut for that token;
- expected value ≥ `MIN_EXPECTED_PROFIT_USD`, where EV = net × the learned
  chance of success (see LEARNING.md);
- price impact ≤ `MAX_PRICE_IMPACT_BPS`.

## 3. Size

The size ladder (`sizer.ts`) quotes a few sizes from `SIZE_LADDER_USD` within
every limit (wallet × `MAX_EXPOSURE_PCT`, `MAX_TRADE_USD`, the MICRO cap),
reusing the size already quoted, and keeps the one with the best expected
value whose impact is acceptable. It only uses requests that are free right
now (keeping room to execute); with no room it acts at the scanned size.

## 4. Fresh re-quote and floor (the "executable" stage)

Right before building, **every leg is re-quoted** back to back. The last leg
is quoted with the slippage that puts its on-chain minimum output at

```
required = in + network costs + in × floor bps
```

If the fresh quote can't meet that, the gap is gone: status `stale`, nothing
is built or sent, no cost. (V1 reused a seconds-old first leg, which turned
latency into "fake gaps".)

## 5. Build

One v0 transaction (`buildCycleTx`): compute-unit limit and price, each leg's
setup and swap instructions (and the last leg's cleanup), then the Jito tip
transfer **last**, so the tip is only paid if every leg succeeded. Address
lookup tables make room; a route that still doesn't fit is `skipped`.

## 6. Simulate, send, land

| Mode | What happens | Amounts |
|---|---|---|
| paper, no wallet | stops after the fresh re-quote | **quoted** (never profit) |
| paper, `WALLET_PUBLIC_KEY` | the exact transaction is simulated on the real chain (no signature, nothing sent); the USDC balance after is read from the simulation | **simulated** |
| micro / live | simulated first (a revert is `rejected`, free); then signed and sent as a Jito `bundleOnly` single-transaction bundle (or plain RPC with `SEND_VIA=rpc`) | **realized** |

Landing is polled until the transaction lands, its blockhash expires (it can
then never land: `rejected`, no fee), or `LANDING_TIMEOUT_MS` passes
(`timeout`: **trading is disabled** until a person checks the signature).

Realized net = USDC after − USDC before − (the transaction's fee + tip). The
fee comes from the transaction itself, so a refundable token-account deposit
isn't counted as a loss. Use a dedicated wallet: anything else moving USDC in
it would distort this.

When a transaction fails on-chain, the failing instruction is mapped back to
the leg that failed (`failedLeg`), so "the price moved before we landed"
(leg 1) can be told apart from other failures.

## Outcomes

| Status | Meaning | Cost |
|---|---|---|
| `filled` | traded (real), would succeed (simulated), or still there at re-quote (quote-only) | fees and tip (real) |
| `stale` | gone at the fresh re-quote | none |
| `rejected` | simulation said it would revert, or it never landed | none |
| `skipped` | not attempted (below floor, route too large, Jito unavailable, no wallet USDC account) | none |
| `failed` | landed and failed | network fee (the tip is last, so not the tip) |
| `timeout` | landing unknown | unknown: trading disabled |

## Latency, stage by stage

Each opportunity records: market change (pool event) → quote start → quote
end → decision (after sizing) → fresh re-quote → built → submitted → landed.
`npm run report` shows the medians; `npm run benchmark` measures each
service from the phone; `npm run backtest` shows how the share of gaps still
there falls as quotes get older.

## Not done (deliberately)

- Own DEX pool maths (reading Raydium/Orca/Meteora state directly). That's
  what same-slot searchers do. It's a large job, only worth it if measured
  data shows gaps living long enough for this bot.
- Bundles of several transactions, and back-running other people's swaps.
