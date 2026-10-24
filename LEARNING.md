# Learning

The bot learns from what actually happened, never from quotes alone. There
are two learners. Neither calls an AI service: that would be too slow for
arbitrage and would cost money.

## 1. Learning engine V2 (`stats.py`): chances of success

The source of truth is the opportunity funnel, `data/opps-<mode>.jsonl`: one
record per acted-on candidate, saying how far it got:

```
quoted → executable (still there at the fresh re-quote) → simulated OK
       → submitted → landed → profitable
```

At startup the whole file is replayed, so nothing is lost on a restart. For
every stage the bot keeps success counts globally and per token, route, size
bucket and UTC hour. A stage's success rate is a Beta-posterior mean, shrunk
toward the global rate so that two lucky samples don't swing it:

```
rate = (successes + 4·m) / (trials + 4)        m = (global successes + 1) / (global trials + 2)
```

Once a route has 5 samples, its rate is averaged with the token's. Stages
never observed use an **explicit prior**, listed as "assumed" in each record:

| Stage | Prior | Replaced by |
|---|---|---|
| executable | 0.5 | re-quotes |
| simulation OK | 0.5 | on-chain simulations |
| landing | `LANDING_PRIOR` (0.5) | MICRO/LIVE submissions |
| profit given landed | 0.9 | landed trades |

The chance of success depends on the mode: in paper it covers only the
stages paper can reach (executable, plus simulation with a wallet); in
MICRO/LIVE, all stages.

**Expected value** of an attempt:

```
paper:      EV = P(success) × net
micro/live: EV = P(executable) × P(sim OK) × P(landing) × (P(profit) × net − (1 − P(profit)) × network fee)
```

A dropped transaction costs nothing (Jito `bundleOnly`); one that lands and
fails costs its network fee.

**Ranking score** = EV × freshness × speed × impact × familiarity:
- freshness `1 / (1 + quote age in s)`;
- speed `1 / (1 + typical latency / 2 s)`;
- impact `1 − price impact / MAX_PRICE_IMPACT_BPS`;
- familiarity 0.8 for discovered tokens, 1 otherwise.

A negative EV stays negative and is never chosen.

## 2. The brain (`brain.py`): pace, focus and thresholds

An older, faster-moving learner (EWMA statistics in `data/brain-<mode>.json`,
saved atomically with a `.bak` copy):

| What | How |
|---|---|
| Profit threshold | Starts at `MIN_PROFIT_BPS`, stays between half and 4×. A trade that **lost** raises it 25 %. A **verified** win (simulated on-chain or real) lowers it 5 %. Gaps gone at the re-quote or rejected count as "phantoms" against the token, threshold unchanged. Quote-only wins change nothing: they aren't evidence. |
| Haircut | Per token, how much quotes overstated on-chain results (EWMA). Quotes are discounted by it before deciding. |
| Token choice | Scans favour tokens with better recent edges, with 20 % exploration. Discovered tokens that stay below −30 bps for 50 scans are dropped. |
| Size buckets | Per token, which share of the maximum size (25/50/100 %) did best. |
| Hot tokens | A price move of 30 bps or more between scans or between two price-watch checks (one cheap request covers every token), or a gap within 5 bps of the bar, gives the token focus scans for a while. |
| Pace | The fastest safe spacing per Jupiter request; slows down on "too many requests" and speeds up after clean scans. |
| Thoughts | Plain-language explanations in `status` and `report`. |

## 3. Probes and gap memory (`probes.py`)

Only gaps above the bar get re-checked as candidates, which is a few a day.
So in paper mode the bot also **probes**: when a scan sees a positive gap
below the bar, it stops there and re-quotes that cycle once, immediately (two
quotes; nothing built or sent; at most `PROBES_PER_HOUR`, default 30). Probes
go to `data/probes-<mode>.jsonl`, apart from the funnel, so they never count
as trades, profit or go-live evidence.

From probes plus every re-quoted opportunity, the gap memory learns how often
a gap is still there (positive and at least half its quoted size) by gap
size, token, venue (DEX), re-check delay and trigger (pool event vs routine
scan). Rates use (held + 1) / (n + 2), and groups need 10+ examples before
the brain says anything about them.

It feeds decisions in one conservative way: a route through a venue whose
gaps hold clearly less often than average (20+ examples) has its expected
value scaled down, to as little as a quarter. It never raises trust above
average. `npm run status` and `npm run report` show what it learned, and
`npm run backtest` uses probes to show how lower bars would have fared.

## 4. Event and latency data

Every record carries timestamps for each stage. When a pool event triggered
the quote, it also carries the market-change time. `npm run report` compares
event-triggered vs polled gaps that were still there at the re-quote, and
`npm run backtest` shows how the share still there falls with quote age. That
is the honest measure of whether the bot is fast enough.

## What it does not learn

- Nothing changes risk limits, trade caps, the mode or the go-live gate. Those
  are settings, changed only by a person.
- No profit target feeds back into risk: missing a target never makes the bot
  take bigger or riskier trades.
- Paper results never count as evidence for real money (see RISK.md).
