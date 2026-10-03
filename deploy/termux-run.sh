#!/data/data/com.termux/files/usr/bin/bash
# Keeps the bot running on an Android phone (Termux).
# - holds a wake lock so Android doesn't put it to sleep
# - restarts it 30s after a crash
# - stays stopped after a deliberate halt (loss floor / retirement)
set -u
cd "$(dirname "$0")/.." || exit 1
mkdir -p data
LOG=data/bot.log
BOT_CMD=${BOT_CMD:-"npx tsx src/index.ts"}
RESTART_DELAY=${RESTART_DELAY:-30}

command -v termux-wake-lock >/dev/null && termux-wake-lock || true

while true; do
  if [ -f data/HALTED ]; then
    echo "$(date -u +%FT%TZ) bot is halted: $(cat data/HALTED)" | tee -a "$LOG"
    echo "Read the reason above, then delete data/HALTED to allow a restart." | tee -a "$LOG"
    break
  fi
  echo "$(date -u +%FT%TZ) starting bot" >>"$LOG"
  $BOT_CMD >>"$LOG" 2>&1
  code=$?
  if [ "$code" -eq 0 ]; then
    echo "$(date -u +%FT%TZ) bot stopped cleanly (exit 0); not restarting" >>"$LOG"
    break
  fi
  echo "$(date -u +%FT%TZ) bot crashed (exit $code); restarting in ${RESTART_DELAY}s" >>"$LOG"
  sleep "$RESTART_DELAY"
done

command -v termux-wake-unlock >/dev/null && termux-wake-unlock || true
