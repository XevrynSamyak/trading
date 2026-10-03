#!/data/data/com.termux/files/usr/bin/sh
# Termux:Boot hook: starts the bot when the phone boots.
# Install: mkdir -p ~/.termux/boot && cp deploy/termux-boot.sh ~/.termux/boot/start-arb-bot && chmod +x ~/.termux/boot/start-arb-bot
termux-wake-lock
cd "$HOME/trading" && nohup bash deploy/termux-run.sh >/dev/null 2>&1 &
