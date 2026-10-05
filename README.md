# Solana arbitrage bot

A small bot that looks for price gaps on Solana DEXes (via Jupiter, which
routes across Raydium, Orca, Meteora and more), trades them by itself, and
keeps its own books on whether it is paying for its bills.

**Read this first:** with $20–30, profits are cents per trade at best, and
professional bots compete for the same gaps. Losing money slowly to fees is
the most likely outcome. The bot is built to limit that downside: it starts in
paper mode, and it stops on its own before losing more than you allow.

## How the money flows

```
 your prepaid / virtual card ──autopay──▶ server + RPC providers (bills)
                                            ▲
                                            │ bot checks: did trading profit cover these?
 fresh Solana wallet ($20–30 USDC + ~$3 SOL for fees) ◀──▶ bot trades
```

- **The bot never holds bank or card details.** Put a prepaid or virtual
  card with a hard spending limit (Revolut virtual card, Privacy.com, etc.)
  on autopay with the providers. If the server is ever hacked, your bank is
  not exposed.
- Turning crypto profit back into bank money goes through an exchange with
  identity checks (KYC). You do that step by hand; the monthly report tells
  you how much surplus there is.
- Running it on an Android phone (see `deploy/ANDROID.md`) with a free RPC
  key keeps the bills at $0 and needs no card. `deploy/SETUP.md` covers a
  cloud server (Oracle free tier) if you get one later.

## What it does each cycle

1. **Brain** (`src/brain.ts`) decides where and how to look:
   - **which tokens**: favours tokens where it has seen gaps, sometimes
     explores others, and every 6 hours **finds new busy, verified tokens by
     itself** (Jupiter token list), dropping finds that prove useless
   - **what size**: tries 25% / 50% / 100% trades per token and learns
     which nets the most dollars (small trades move the price less)
   - **when**: learns which hours of the day show the best gaps and scans
     faster then; also speeds up when a gap is almost big enough and slows
     down when nothing is close (saves the free API quota)
   - **sudden moves**: when a token's price jumps between scans (when gaps
     tend to open) it checks that token first and scans faster for a while
   - **how much to trust quotes**: from on-chain tests it learns how much
     each token's quotes overstate reality, and discounts them by that
   - **explains itself**: `npm run report` and the daily message say, in
     plain language, what it noticed and why it acts that way
2. **Scanner** quotes USDC → token → USDC for each one and subtracts
   network fees.
3. If the expected net profit beats the bar, **executor** re-quotes and puts
   *all legs in one transaction*, with an on-chain minimum output of
   input + estimated costs + minimum profit. If prices moved, the whole
   transaction reverts instead of filling at a loss. (The minimum covers the
   USDC side; network costs are estimated in SOL, so realized profit can
   still differ slightly from the estimate.)
4. Results go to the **ledger**; the brain learns from them (pickier after
   failures, looser after wins, less trust in tokens whose gaps turn out
   fake) and saves what it learned to disk.

## Testing honestly before going live

Quotes are optimistic: many gaps vanish before a trade could land. So paper
mode has two levels:

- **Quote-only** (no wallet set): fast to start, but results are too rosy.
- **On-chain tested** (`WALLET_PUBLIC_KEY` set to your fresh, funded bot
  wallet): for every opportunity the bot builds the *exact* transaction live
  mode would send and simulates it on the real chain right now. Nothing is
  signed or sent, and no secret key is needed. Gaps that wouldn't hold are
  counted as **fake gaps**; real ones record what they'd actually have made.

`npm run report` ends with a **go-live verdict** that never counts quotes or
paper profits as evidence:

- **MICRO LIVE: YES** only after at least 3 days of paper testing and 30
  trades simulated on-chain, of which at least 30% succeeded and made money
  on average after every cost.
- **FULL LIVE: YES** only after at least 20 MICRO trades landed, at least 70%
  were profitable, realized P&L is positive, and no landing went unconfirmed.
  The bot **refuses to start** `MODE=live` otherwise.

Each "NO" lists its reasons, e.g. `Insufficient real execution sample`.

## Token safety

Before quoting a token, the bot reads its mint on-chain (one batched call,
re-checked daily, cached in `data/token-safety.json`) and gives it a state:

- **BLOCKED** (never quoted): transfer fees, transfer hooks, a permanent
  delegate, accounts frozen by default, paused or non-transferable tokens:
  anything that makes a swap behave differently from its quote.
- **WATCH** (quoted to learn, never traded): a *discovered* token whose issuer
  can freeze accounts or mint more, or with thin liquidity, few holders, a
  pool younger than a week, or ownership concentrated in a few wallets.
- **PAPER_ONLY**: other discovered tokens. Real trades need them listed in
  `LIVE_TOKENS`.
- **LIVE_ALLOWED**: your configured tokens (after the on-chain check) and
  allowlisted ones. MICRO and LIVE only quote and trade these.

`npm run report` lists every token's state and why.

## Live trading through Jito

Real trades go through Jito's block engine as single-transaction bundles
(`SEND_VIA=jito`, the default). Jito documents these as revert-protected: a
transaction that would fail is dropped instead of landing, and the tip is
only paid when it lands. **This has not yet been observed with this bot** —
MICRO mode exists to measure it. Even then, attempts are not free in
practice: they spend request budget, can lose the race to faster bots, and
the tip and fees eat into every landed trade. Every trade is simulated
first, so attempts that would clearly fail are never sent.

## Speed and API limits

Prices come from Jupiter, which allows **30 requests/min without a key** and
**60 with a free key** (`JUPITER_API_KEY`). Checking one token costs 2
requests, so a full scan of 3 tokens costs 6. The bot counts every request and
never exceeds the limit in any 60-second window. Short bursts also seem to
count, so it additionally keeps any 10 seconds to a sixth of the limit (minus
one) and checks tokens one after another instead of all at once.

With the free key that is ~9 full scans a minute. When a token is moving fast
or a gap is nearly big enough, the bot switches to **focus scans** of just
that token (2 requests), re-checking it about every 2 seconds, with a full
scan every third time so nothing else is ignored. Wallet balances (Helius)
are read at most once a minute to stay well inside the free RPC plan.

## Event triggers and latency

Besides checking tokens in turn, the bot listens over the RPC's WebSocket to
the pools its routes use (`EVENT_TRIGGERS=on`). When one changes, that token
is quoted right away instead of waiting its turn, and every opportunity
records how long it took from that change to the quote. Limits keep it cheap:
at most `MAX_WATCHED_POOLS` pools, at most `EVENT_DAILY_CAP` updates a day,
and pools that change nearly every block are rested for an hour (constant
change carries no signal). `npm run report` compares how often event-triggered
and polled gaps were still there at the fresh re-quote.

`npm run benchmark` measures, from your phone, how long the RPC, Jupiter
(both legs), Jito and the WebSocket take, and so how long a gap must last for
this bot to even confirm it. Nothing is signed or sent. While the bot runs it
skips the Jupiter part (the bot uses the whole request limit and times its own
quotes; `npm run status` shows them).

## Limits

There is **no profit cap**. Trade size is a share of the wallet
(`MAX_EXPOSURE_PCT`), so trades grow as the wallet grows. The only limits are
on losses:

| Guard | Default | Effect |
|---|---|---|
| `MICRO_MAX_TRADE_USD` | $5 | Hard cap per trade in MICRO mode |
| `LOSS_FLOOR_USD` | 70% of start | Stops permanently (writes `data/HALTED`) |
| `DAILY_LOSS_LIMIT_USD` | $2 | Pauses until the next UTC day |
| `MAX_CONSECUTIVE_FAILURES` | 5 | 10-minute cooldown |
| `MAX_CONSECUTIVE_LOSSES` | 3 | 10-minute cooldown |
| `UNEXPECTED_LOSS_USD` | $0.05 | A real trade losing more, or a landing that can't be confirmed, **disables trading** until you re-enable it |
| `SUSTAIN_STOP_AFTER_MONTHS` | 2 | Retires if it didn't cover its bills 2 months running |

**Emergency stop:** `npm run stop-trading` (writes `data/TRADING_DISABLED`;
the running bot stops trading within seconds and waits). Only
`npm run enable-trading` lifts it, after you've checked why it stopped.

## Running

**On an Android phone (free):** follow `deploy/ANDROID.md`.

On any computer with Node 20+:

```bash
npm install
cp .env.example .env     # edit it
npm start                # paper mode by default (or: npm run paper)
npm run status           # is it running, what it's doing, test progress
npm run watch            # same, live (refreshes every 5s)
npm run report           # quoted vs simulated vs realized, risk, go-live verdict
npm run benchmark        # measured latency to RPC, Jupiter, Jito, WebSocket
npm run stop-trading     # emergency stop; npm run enable-trading lifts it
npm test
```

### Going live

Only after `npm run report` says `MICRO LIVE: YES`:

1. You already have the **brand-new** bot wallet from on-chain testing
   (USDC + ~$3 of SOL for fees and refundable token-account deposits).
2. In `.env`: `MODE=micro` (tiny real trades, capped at `MICRO_MAX_TRADE_USD`),
   `LIVE_TRADING_CONFIRM=yes`, `PRIVATE_SIGNING_KEY=<base58 secret of that
   wallet>`. Never a seed phrase, and never paste it into any chat.
3. Watch the first trades on solscan.io. `MODE=live` (adaptive size) only
   starts once `npm run report` says `FULL LIVE: YES`.

Amounts are always labelled: **quoted** (quotes only — never profit),
**simulated** (the exact transaction simulated on-chain, nothing sent) and
**realized** (real transactions). Only simulated and realized amounts count.
