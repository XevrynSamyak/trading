import type { Config } from "./config.js";

export function makeNotifier(cfg: Pick<Config, "telegramBotToken" | "telegramChatId">) {
  return async (text: string): Promise<void> => {
    console.log(`[${new Date().toISOString()}] ${text}`);
    if (!cfg.telegramBotToken || !cfg.telegramChatId) return;
    try {
      await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.telegramChatId, text }),
      });
    } catch (err) {
      console.error("telegram notify failed:", err);
    }
  };
}
