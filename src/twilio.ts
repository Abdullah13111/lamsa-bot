/** WhatsApp through Twilio (sandbox or a Twilio sender): webhook parsing, signature check, sending replies. */
import { type Env, setting } from "./env";
import type { Incoming } from "./whatsapp";
import { safeEqual } from "./whatsapp";

const encoder = new TextEncoder();

/**
 * Twilio signs each webhook: base64 HMAC-SHA1 (auth token) of the full URL followed by
 * every POST field as name + value, sorted by name (X-Twilio-Signature).
 */
export async function verifySignature(url: string, params: URLSearchParams, header: string | null, authToken: string) {
  if (!authToken || !header) return false;
  const data = url + [...params].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => k + v).join("");
  const key = await crypto.subtle.importKey("raw", encoder.encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
  return safeEqual(btoa(String.fromCharCode(...mac)), header);
}

/** Twilio posts one message per webhook. Status callbacks (no Body field) are skipped. */
export function parse(params: URLSearchParams): Incoming | null {
  const from = params.get("From") ?? "";
  if (!from.startsWith("whatsapp:") || !params.has("Body")) return null;
  const media = Number(params.get("NumMedia") ?? "0") > 0;
  return {
    messageId: params.get("MessageSid") ?? "",
    phoneNumberId: params.get("To") ?? "", // our sender, "whatsapp:+14155238886"
    sender: from.replace(/^whatsapp:\+?/, ""),
    type: media ? "media" : "text",
    text: (params.get("Body") ?? "").trim(),
  };
}

const LAMSA_WORDS = ["lamsa", "لمسة", "لمسه"];
const FORWARD_WORDS = ["price", "prices", "أسعار", "اسعار"];

/** Shared sandbox: a message that is only a switch word picks the bot ("lamsa" / "forward"). */
export function routeCommand(text: string): "lamsa" | "forward" | null {
  const word = text.trim().toLowerCase().replace(/[.!*]+$/, "");
  if (LAMSA_WORDS.includes(word)) return "lamsa";
  if (FORWARD_WORDS.includes(word)) return "forward";
  return null;
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** TwiML answer to a webhook: an instant reply, or nothing. */
export function twiml(message?: string): Response {
  const body = message ? `<Response><Message>${escapeXml(message)}</Message></Response>` : "<Response/>";
  return new Response(body, { headers: { "Content-Type": "text/xml" } });
}

/**
 * Passes the webhook on to the other bot and returns its TwiML. `offline` is sent instead
 * when it doesn't answer (e.g. the PC running it is off).
 */
export async function forward(url: string, params: URLSearchParams, offline: string): Promise<Response> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "ngrok-skip-browser-warning": "1" },
      body: params,
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) return new Response(await r.text(), { headers: { "Content-Type": "text/xml" } });
    console.warn(`Forward to ${url} failed: HTTP ${r.status}`);
  } catch (e) {
    console.warn(`Forward to ${url} failed: ${e}`);
  }
  return twiml(offline);
}

export async function sendText(env: Env, from: string, to: string, body: string): Promise<void> {
  const sid = setting(env, "TWILIO_ACCOUNT_SID");
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${sid}:${setting(env, "TWILIO_AUTH_TOKEN")}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: from, To: `whatsapp:+${to}`, Body: body.slice(0, 1600) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status >= 400) console.error(`Twilio send failed: HTTP ${r.status} ${(await r.text()).slice(0, 500)}`);
}
