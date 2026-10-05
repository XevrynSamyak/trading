# Risk

Every guard limits losses. Nothing limits profit, and nothing raises risk
to reach a profit target.

## Modes and the go-live gate

| Mode | Real money | How to start | Gate |
|---|---|---|---|
| **PAPER** (default) | never: nothing is signed or sent | `npm start` / `npm run paper` | none |
| **MICRO** | yes, each trade capped at `MICRO_MAX_TRADE_USD` ($5, max $25) | `MODE=micro`, `LIVE_TRADING_CONFIRM=yes`, `PRIVATE_SIGNING_KEY` | warns at startup unless the paper evidence below holds |
| **LIVE** | yes, adaptive size | `MODE=live`, `LIVE_TRADING_CONFIRM=yes`, `PRIVATE_SIGNING_KEY` | **refuses to start** unless the MICRO evidence below holds |

An unknown `MODE` falls back to paper. A real-money mode without
`LIVE_TRADING_CONFIRM=yes` or a signing key refuses to start (exit 2; the
phone runner does not restart it).

**MICRO LIVE: YES** needs, from paper mode with on-chain simulation:
- ≥ `GATE_MIN_PAPER_DAYS` (3) days of paper testing;
- ≥ `GATE_MIN_SIMULATED` (30) trades simulated on-chain;
- ≥ `GATE_MIN_SIM_SUCCESS_RATE` (30 %) of them succeeding;
- the successful ones making money on average after every cost.

**FULL LIVE: YES** needs, from MICRO:
- ≥ `GATE_MICRO_MIN_TRADES` (20) trades landed;
- ≥ `GATE_MICRO_MIN_PROFITABLE_RATE` (70 %) of them profitable;
- positive realized P&L;
- no unconfirmed landing.

Quote-only results never count. The kill switch or a halt blocks both.

## Loss guards

| Guard | Default | Effect |
|---|---|---|
| Per-trade size | `MAX_EXPOSURE_PCT` 80 % of USDC on hand, `MAX_TRADE_USD`, MICRO cap | the smallest applies; the size ladder stays within it |
| On-chain floor | input + network costs + floor bps | the last leg must return at least this, or the whole transaction reverts |
| `LOSS_FLOOR_USD` | 70 % of the start | stops for good (`data/HALTED`) |
| `DAILY_LOSS_LIMIT_USD` | $2 | pauses until the next UTC day |
| `MAX_CONSECUTIVE_FAILURES` | 5 landed failures | 10-minute cooldown |
| `MAX_CONSECUTIVE_LOSSES` | 3 losing trades (checked results only) | 10-minute cooldown |
| `UNEXPECTED_LOSS_USD` | $0.05 | a real trade losing more trips the **kill switch** |
| Unknown outcome | landing not confirmed within `LANDING_TIMEOUT_MS` (120 s), or landed with an unreadable result | trips the **kill switch** |
| `SUSTAIN_STOP_AFTER_MONTHS` | 2 | retires after 2 months in a row of not covering the bills |

## Kill switch

`npm run stop-trading`, the status page's stop button, or the bot itself
writes `data/TRADING_DISABLED`. The bot checks it every cycle and again right
before sending; while it exists the bot only waits (status: DISABLED). It
survives restarts. Only `npm run enable-trading`, run by a person after
checking why, lifts it. Nothing over HTTP can lift it.

## Token risk

Trades are atomic round trips: the bot never holds a token between
transactions, and a bad token makes the transaction revert. The remaining
dangers are tokens whose transfers behave differently from their quotes, and
thin or fake markets. Token safety (README) blocks the first, and keeps
discovered tokens out of real trading unless allowlisted in `LIVE_TOKENS`.

## Execution risk (what can still go wrong)

- **Jito revert protection is documented, not yet observed with this bot.**
  MICRO exists to measure it. Without it, a transaction that lands and fails
  pays its network fee.
- **The floor uses a SOL price up to 5 minutes old** for the fee part. A
  sharp SOL move can make a "floor-safe" trade lose a fraction of a cent.
- **Realized P&L is a balance difference.** Use a dedicated wallet;
  anything else moving USDC in it distorts the numbers.
- **Competition:** professional searchers act within the same block (about
  400 ms). Gaps this bot can see are mostly the ones they already took or
  didn't want. See PROFITABILITY.md.

## Secrets

- `WALLET_PUBLIC_KEY` (public address) and `PRIVATE_SIGNING_KEY` (secret) are
  separate. The secret is loaded only in MICRO/LIVE.
- The bot refuses to start if any setting looks like a seed phrase, a secret
  key sits in the public slot, the two don't match, or aliases disagree. It
  warns if a signing key is present in paper mode or `.env` is readable by
  others.
- Every printed line is redacted: API keys in URLs or headers, Jupiter and
  Telegram tokens, status-page tokens, anything shaped like a secret key.
- Never paste a seed phrase or secret key into any chat. The bot never asks
  for one.
- `.env` and `data/` are git-ignored. Rotate any key that was ever pasted
  somewhere.
