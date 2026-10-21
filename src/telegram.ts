/** Owner alerts through a Telegram bot (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID). Off when either is missing. */
import { type Env, setting } from "./env";

/** Never throws: a failed alert must not lose the customer's reply. */
export async function notifyOwner(env: Env, text: string): Promise<void> {
  const token = setting(env, "TELEGRAM_BOT_TOKEN");
  const chatId = setting(env, "TELEGRAM_CHAT_ID");
  if (!token || !chatId) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) console.error(`Telegram alert failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  } catch (e) {
    console.error(`Telegram alert failed: ${e}`);
  }
}
