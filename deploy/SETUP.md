# Free-tier server setup (Oracle Cloud "Always Free")

Goal: fixed monthly bills of ~$0, so every cent of profit counts.

1. Create an Oracle Cloud account -> Compute -> Create instance.
   Shape: `VM.Standard.A1.Flex` (Ampere, Always Free), image: Ubuntu 24.04.
2. SSH in and install the bot (Python 3.10+; Ubuntu 24.04 has 3.12):
   ```bash
   sudo apt-get update && sudo apt-get install -y python3 python3-venv git
   git clone https://github.com/xevrynsamyak/trading.git && cd trading
   python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
   cp .env.example .env && nano .env
   ```
3. Run in paper mode for a few days: `.venv/bin/python -m arbbot start`.
   Check with `.venv/bin/python -m arbbot report`.
4. Install as a service so it restarts on reboot/crash:
   ```bash
   sudo cp deploy/arb-bot.service /etc/systemd/system/
   sudo systemctl enable --now arb-bot
   journalctl -u arb-bot -f
   ```
5. Free RPC: sign up at helius.dev (free tier) and put the URL in `RPC_URL`.
