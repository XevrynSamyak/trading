"""Important events: logged, and sent to Telegram when TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set."""

from typing import Awaitable, Callable

from .log import log, redact


def make_notifier(cfg, client) -> Callable[[str], Awaitable[None]]:
    async def notify(text: str) -> None:
        log.event(text)
        if not cfg.telegram_bot_token or not cfg.telegram_chat_id:
            return
        try:
            await client.post(
                f"https://api.telegram.org/bot{cfg.telegram_bot_token}/sendMessage",
                json={"chat_id": cfg.telegram_chat_id, "text": redact(text)},
            )
        except Exception as err:  # noqa: BLE001 - a failed notification must never stop the bot
            log.warn("telegram notify failed:", redact(str(err)))

    return notify
