# Free-tier server setup (Oracle Cloud "Always Free")

Goal: fixed monthly bills of ~$0, so every cent of profit counts.

1. Create an Oracle Cloud account -> Compute -> Create instance.
   Shape: `VM.Standard.A1.Flex` (Ampere, Always Free), image: Ubuntu 24.04.
2. SSH in and install Node 22:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs git
   git clone https://github.com/xevrynsamyak/trading.git && cd trading
   npm ci
   cp .env.example .env && nano .env
   ```
3. Run in paper mode for a few days: `npm start`. Check with `npm run report`.
4. Install as a service so it restarts on reboot/crash:
   ```bash
   sudo cp deploy/arb-bot.service /etc/systemd/system/
   sudo systemctl enable --now arb-bot
   journalctl -u arb-bot -f
   ```
5. Free RPC: sign up at helius.dev (free tier) and put the URL in `RPC_URL`.
