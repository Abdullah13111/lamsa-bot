/** Worker bindings: vars from wrangler.jsonc, secrets from `wrangler secret put`. */
export interface Env {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  // D1 database (wrangler.jsonc). Missing = in-memory storage (tests).
  DB?: D1Database;
  // WhatsApp Cloud API (Meta). One WhatsApp number per deployment for now,
  // answering as WA_CLIENT_ID.
  WA_VERIFY_TOKEN?: string;
  WA_APP_SECRET?: string;
  WA_ACCESS_TOKEN?: string;
  WA_GRAPH_VERSION?: string;
  WA_CLIENT_ID?: string;
  // WhatsApp through Twilio (sandbox), webhook /twilio. Also answers as WA_CLIENT_ID.
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  // Our WhatsApp number on Twilio ("whatsapp:+14155238886"), for messages the admin page sends.
  TWILIO_WHATSAPP_FROM?: string;
  // Shared sandbox: webhook of the other bot on the same Twilio account. When set, numbers
  // go there unless they send "lamsa" (and "price" sends them back). Empty = all Lamsa.
  TWILIO_FORWARD_URL?: string;
  // Comma-separated sites allowed to call /chat.
  CORS_ORIGINS?: string;
  // Password for /admin/bookings (any username). Empty = admin page disabled.
  ADMIN_TOKEN?: string;
  WEB_LIMITER?: RateLimit;
}

export function setting(env: Env, name: keyof Env, fallback = ""): string {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
