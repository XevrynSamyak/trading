# Run the bot on an Android phone (free, no card needed)

Any Android 7+ phone works; an old spare phone is ideal. It runs 24/7 on the
charger and uses about $0.50–1 of electricity a month.

## 1. Install the apps (from F-Droid, not the Play Store)

The Play Store version of Termux is outdated and broken. Get F-Droid from
https://f-droid.org, then install from inside F-Droid:

- **Termux** – the Linux terminal the bot runs in
- **Termux:Boot** – restarts the bot after the phone reboots
- **Termux:API** – lets the bot keep the phone awake

Open Termux:Boot once after installing it (that activates it).

## 2. Stop Android from killing it

Settings → Apps → Termux → Battery → **Unrestricted** (or "Don't optimize").
Do the same for Termux:Boot. On Xiaomi/Samsung/Oppo also allow **Autostart**.
Keep the phone plugged in and on Wi-Fi.

## 3. Install the bot

In Termux:

```bash
pkg update -y && pkg install -y nodejs git termux-api
git clone https://github.com/xevrynsamyak/trading.git
cd trading
git checkout claude/keen-ptolemy-y8ns0k
npm ci
cp .env.example .env
nano .env        # edit settings; Ctrl+O to save, Ctrl+X to exit
```

Leave `MODE=paper` for now. Paste your Helius URL into `.env`:

```
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

Then check everything connects:

```bash
npm run check
```

Every line should say `OK` (Wallet says `SKIP` until you add one).

## 4. Start it

```bash
bash deploy/termux-run.sh &
tail -f data/bot.log      # watch it (Ctrl+C stops watching, not the bot)
```

You should see `Started in PAPER mode` followed by `best ...` scan lines.

Auto-start after a reboot:

```bash
mkdir -p ~/.termux/boot
cp deploy/termux-boot.sh ~/.termux/boot/start-arb-bot
chmod +x ~/.termux/boot/start-arb-bot
```

## 5. Make the test realistic (recommended)

Quote-only paper results are too optimistic. To have the bot test every
trade on the real chain (nothing is sent, no secret key needed):

1. In Phantom (or Solflare), **create a new wallet/account** just for the bot.
2. Send it the bot's money: about $20 of USDC plus ~$3 of SOL (network fees, plus a refundable ~0.002 SOL deposit the first time it trades each token).
3. Copy that account's **public address** (starts with a letter/number,
   ~44 characters) and put it in `.env`:
   ```
   WALLET_PUBLIC_KEY=YourBotWalletAddressHere
   ```
4. `npm run check` should show your balances and
   `-> paper trades will be tested on-chain`.
5. Restart the bot (see "Stop it" below, then start it again).

Never paste the wallet's secret key or seed phrase anywhere for this step.

## 6. Check on it

```bash
cd ~/trading && npm run report
```

The last lines give a **Go live?** verdict. Only consider live trading when it
says `TRY-LIVE`.

Optional: put `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env` (create a
bot with @BotFather) to get trade alerts and daily summaries on your main
phone.

Stop it: `pkill -f termux-run.sh; pkill -f src/index.ts`

Running `termux-run.sh` again while the bot is running is safe: it just
says it's already running.

## Safety

- Lock the phone with a PIN. The `.env` file holds the bot wallet's key.
- Use a **brand-new wallet** holding only the bot's money. Never put your main
  wallet's key on this phone.
- If the bot halts (it writes `data/HALTED`), read why before deleting that
  file to restart it.

## Why not PythonAnywhere?

Its free plan only allows connections to an approved list of websites
(Solana and Jupiter aren't on it), can't keep a program running all day, and
this bot runs on Node rather than Python. The paid plan needs a card.
