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
 fresh Solana wallet ($20–30 USDC + ~$2 SOL for fees) ◀──▶ bot trades
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

1. **Brain** (`src/brain.ts`) picks which tokens to check, favouring those
   where it has seen gaps before and occasionally exploring others.
2. **Scanner** quotes USDC → token → USDC for each one and subtracts
   network fees.
3. If the net profit beats the brain's current threshold, **executor** puts
   *both legs in one transaction*, with an on-chain minimum output that
   guarantees profit. If prices moved, the whole transaction reverts
   (usually caught in simulation, so no fee at all).
4. Results go to the **ledger**; the brain learns from them (pickier after
   failures, looser after wins) and saves what it learned to disk.

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

Only after paper mode has shown profit for several days:

1. Create a **brand-new** wallet (e.g. `solana-keygen new`, or a new account
   in Phantom/MetaMask). Fund it with USDC + ~$2 of SOL for fees.
2. In `.env`: `MODE=live`, `LIVE_TRADING_CONFIRM=yes`,
   `WALLET_SECRET_KEY=<base58 secret>`.
3. Set `MAX_TRADE_USD=1` for the first run, watch a trade on solscan.io, then
   set it back to `0`.

Paper mode assumes quotes fill exactly, so real results will be worse.
