# Profitability: what to expect, and how to know

Short version: **this bot has not made money, and it is unproven whether it
can.** V2 is built to find out honestly and cheaply, without risking more
than a few dollars on the way.

## Four kinds of numbers, never mixed

| Basis | What it is | Counts as money? |
|---|---|---|
| **quoted** | the scan's quotes after estimated costs | **never** |
| **executable** | every leg re-quoted moments later, still above the floor | no: still a quote |
| **simulated** | the exact transaction simulated on the real chain (paper + `WALLET_PUBLIC_KEY`) | paper P&L only, labelled simulated |
| **realized** | real transactions (MICRO/LIVE), measured from wallet balances and the transaction's fee | **yes, the only real money** |

Screens and the report always label which is which. Quoted amounts are shown
as "NOT profit".

## What one trade can make

```
net = (quoted out − in)              DEX fees and price impact already inside
      − base fee (5,000 lamports)
      − priority fee (1,000 lamports via Jito)
      − Jito tip (25 % of what's left, between 1,000 and 2,000,000 lamports)
      − safety buffer (3 bps of the size + $0.001)
```

For a $20 trade that is about $0.001 of network fees and $0.007 of buffer
(about 4 bps together) plus the tip, and the default bar asks for 20 bps
more. So even a real gap pays **cents per trade** at this wallet size.

Profit per trade is size × realized edge. Reaching **$20–30 per trade** would
need about:

| Realized net edge | Capital needed per trade |
|---|---|
| 1 % | $2,000–3,000 |
| 0.5 % | $4,000–6,000 |
| 0.2 % | $10,000–15,000 |

No measurement so far supports edges like these after costs, so nothing
supports adding capital. **The bot will not take bigger or riskier trades to
reach a target**: size is capped by the settings and the size ladder only
picks, within those caps, the size with the best expected value.

## Why profit is hard here

1. **A round trip through one aggregator is mostly noise.** Jupiter already
   routes each direction through the best venue it knows, so USDC → X → USDC
   is about −(fees + spread) when both quotes see the same market. Most
   positive "gaps" come from the market moving between quotes. V2 re-quotes
   every leg before building, and the funnel shows how many gaps survive
   (step "executable").
2. **Competition is faster.** Professional searchers read pool state directly
   and land in the same ~400 ms block. A phone using HTTP quotes needs a gap
   to last at least two quote round trips (`npm run benchmark` measures
   this), then build, simulate, send and land.
3. **The request budget is small.** 60 quotes a minute with a free key, about
   9 full scans a minute. V2 spends it where markets move (event triggers,
   focus scans), stops a scan at the first real candidate, and keeps room to
   execute at once.
4. **Small capital** (above): cents per trade at best.

## The evidence ladder

Each rung must show results before the next; the go-live gate (RISK.md)
enforces the last two.

1. **Paper, quote-only.** Shows whether quoted gaps survive a fresh re-quote:
   `npm run report` (funnel, "still there at re-quote") and `npm run
   backtest` (how fast gaps die).
2. **Paper with on-chain simulation** (`WALLET_PUBLIC_KEY` = a funded, fresh
   wallet; no secret needed). Shows whether the exact transactions would
   succeed and what they'd make after all costs. Needs ≥ 30 simulated trades,
   ≥ 30 % successful and positive on average, over ≥ 3 days.
3. **MICRO** ($5 per trade max). Shows landing rate, real costs and realized
   P&L. Needs ≥ 20 landed, ≥ 70 % profitable, positive P&L, no unconfirmed
   landing.
4. **LIVE.** Only then.

If rung 1 or 2 keeps showing nothing, the honest conclusion is that this
design can't compete from a phone. Rather than adding risk, the next step
would be a different design: reading pool state directly, or a server near
the validators. Both are large projects to take on only with evidence.

## Reading the numbers

- `npm run report`: funnel counts, average and median net edge per basis,
  landing and profitability rates, latency per stage, best token, route and
  size by realized (else simulated) results, never by quotes; token safety,
  risk status and the go-live verdict with reasons.
- `npm run backtest`: what stricter rules would have done.
- `npm run benchmark`: how fast this phone is.
- `npm run status` / `watch`: live progress, quote time, events, funnel today.
