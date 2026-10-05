import type { Config } from "./config.js";
import { log, redact } from "./log.js";

export function makeNotifier(cfg: Pick<Config, "telegramBotToken" | "telegramChatId">) {
  return async (text: string): Promise<void> => {
    log.event(text);
    if (!cfg.telegramBotToken || !cfg.telegramChatId) return;
    try {
      await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.telegramChatId, text: redact(text) }),
      });
    } catch (err) {
      log.warn("telegram notify failed:", err);
    }
  };
}
