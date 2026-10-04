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
3. If the net profit beats the brain's current threshold, **executor** puts
   *both legs in one transaction*, with an on-chain minimum output that
   guarantees profit. If prices moved, the whole transaction reverts
   (usually caught in simulation, so no fee at all).
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

`npm run report` ends with a **Go live?** verdict based only on on-chain
tested results: `KEEP-TESTING`, `NO-GAPS`, `VERIFY-FIRST`, `ALL-FAKE`,
`NOT-WORTH-IT` or `TRY-LIVE`.

## Live trading through Jito

Live trades go through Jito's block engine as revert-protected transactions
(`SEND_VIA=jito`, the default): if the gap is gone, the transaction is
dropped and **costs nothing**. The tip (`JITO_TIP_LAMPORTS`) is only paid
when it lands, and it can only land at a profit. Every trade is also
simulated first, for free, so doomed attempts are never sent.

## Limits

There is **no profit cap**. Trade size is a share of the wallet
(`TRADE_SIZE_PCT`), so trades grow as the wallet grows. The only limits are
on losses:

| Guard | Default | Effect |
|---|---|---|
| `LOSS_FLOOR_USD` | 70% of start | Stops permanently (writes `data/HALTED`) |
| `DAILY_LOSS_LIMIT_USD` | $2 | Pauses until the next UTC day |
| `MAX_CONSECUTIVE_FAILURES` | 5 | 10-minute cooldown |
| `SUSTAIN_STOP_AFTER_MONTHS` | 2 | Retires if it didn't cover its bills 2 months running |

## Running

**On an Android phone (free):** follow `deploy/ANDROID.md`.

On any computer with Node 20+:

```bash
npm install
cp .env.example .env     # edit it
npm start                # paper mode by default
npm run report           # P&L, bills verdict, what the brain learned
npm test
```

### Going live

Only after `npm run report` says `TRY-LIVE`:

1. You already have the **brand-new** bot wallet from on-chain testing
   (USDC + ~$3 of SOL for fees and refundable token-account deposits).
2. In `.env`: `MODE=live`, `LIVE_TRADING_CONFIRM=yes`,
   `WALLET_SECRET_KEY=<base58 secret of that wallet>`.
3. Set `MAX_TRADE_USD=1` for the first run, watch a trade on solscan.io, then
   set it back to `0`.

Paper mode assumes quotes fill exactly, so real results will be worse.
