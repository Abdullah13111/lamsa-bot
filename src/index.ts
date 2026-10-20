/** HTTP entry points: web chat, WhatsApp webhooks (Meta, Twilio), bookings admin page. */
import * as agent from "./agent";
import { getClient } from "./clients";
import { type Env, setting } from "./env";
import { getStore, type BookingRow } from "./store";
import * as twilio from "./twilio";
import * as whatsapp from "./whatsapp";

// Ceiling for all web visitors together, in case per-IP limits are dodged.
const WEB_TOTAL_PER_HOUR = 300;

const UNSUPPORTED_REPLY =
  "أقدر أقرأ الرسائل النصية بس حالياً، اكتبي لي سؤالك لو سمحتي.\n" +
  "I can only read text messages for now. Please type your question.";

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(data, { status, headers });
const error = (status: number, detail: string, headers: HeadersInit = {}) => json({ detail }, status, headers);

function corsHeaders(env: Env, request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = setting(env, "CORS_ORIGINS").split(",").map((o) => o.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

const str = (v: unknown, min: number, max: number) => typeof v === "string" && v.length >= min && v.length <= max;

async function chat(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(env, request);
  let body: any;
  try {
    body = await request.json();
  } catch {
    return error(422, "Invalid JSON", cors);
  }
  if (!str(body?.client_id, 0, 40) || !str(body?.message, 1, 1000) || !str(body?.session_id, 1, 100)) {
    return error(422, "Invalid request", cors);
  }
  const client = getClient(body.client_id);
  if (!client) return error(404, "Unknown client", cors);

  const ip = request.headers.get("CF-Connecting-IP") ?? "?";
  const perIp = env.WEB_LIMITER ? (await env.WEB_LIMITER.limit({ key: ip })).success : true;
  const store = getStore(env);
  if (!perIp || (await store.countUserMessages("web", 60)) >= WEB_TOTAL_PER_HOUR) {
    return error(429, "Too many messages, please try again in a few minutes", cors);
  }
  const reply = await agent.handleMessage(env, client, `web:${body.session_id}`, "web", body.message.trim());
  return json({ reply }, 200, cors);
}

/** Meta calls this once when you save the webhook URL in the app dashboard. */
function verifyWebhook(url: URL, env: Env): Response {
  const token = setting(env, "WA_VERIFY_TOKEN");
  const p = url.searchParams;
  if (p.get("hub.mode") === "subscribe" && token && whatsapp.safeEqual(p.get("hub.verify_token") ?? "", token)) {
    return new Response(p.get("hub.challenge") ?? "", { headers: { "Content-Type": "text/plain" } });
  }
  return error(403, "Verification failed");
}

async function receiveWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = await request.arrayBuffer();
  const ok = await whatsapp.verifySignature(raw, request.headers.get("X-Hub-Signature-256"), setting(env, "WA_APP_SECRET"));
  if (!ok) {
    console.warn("Rejected webhook with a bad or missing signature");
    return error(403, "Bad signature");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return error(400, "Invalid JSON");
  }
  // Answer Meta at once; a slow reply would make it retry the webhook.
  for (const msg of whatsapp.parse(payload)) ctx.waitUntil(handleWhatsapp(env, msg, whatsapp.sendText));
  return json({ ok: true });
}

/** Twilio WhatsApp (sandbox): same bot, replies go out through Twilio's API. */
async function receiveTwilio(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const params = new URLSearchParams(await request.text());
  const ok = await twilio.verifySignature(
    request.url,
    params,
    request.headers.get("X-Twilio-Signature"),
    setting(env, "TWILIO_AUTH_TOKEN"),
  );
  if (!ok) {
    console.warn("Rejected Twilio webhook with a bad or missing signature");
    return error(403, "Bad signature");
  }
  // Empty TwiML now, the reply follows by API, so a slow model can't hit Twilio's 15 s timeout.
  const msg = twilio.parse(params);
  if (msg) ctx.waitUntil(handleWhatsapp(env, msg, twilio.sendText));
  return new Response("<Response/>", { headers: { "Content-Type": "text/xml" } });
}

type Send = (env: Env, from: string, to: string, body: string) => Promise<void>;

async function handleWhatsapp(env: Env, msg: whatsapp.Incoming, send: Send): Promise<void> {
  try {
    const store = getStore(env);
    if (msg.messageId && !(await store.markSeen(msg.messageId))) return;
    const clientId = setting(env, "WA_CLIENT_ID", "lamsa");
    const client = getClient(clientId);
    if (!client) {
      console.error(`WA_CLIENT_ID "${clientId}" has no clients/<id>.md file`);
      return;
    }
    const reply =
      msg.type !== "text" || !msg.text
        ? UNSUPPORTED_REPLY
        : await agent.handleMessage(env, client, `wa:${msg.sender}`, "whatsapp", msg.text.slice(0, 1000), `+${msg.sender}`);
    await send(env, msg.phoneNumberId, msg.sender, reply);
  } catch (e) {
    console.error(`Failed to handle WhatsApp message ${msg.messageId}: ${e instanceof Error ? e.stack : e}`);
  }
}

function adminPassword(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Basic ")) return null;
  try {
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0)));
    const colon = decoded.indexOf(":");
    return colon >= 0 ? decoded.slice(colon + 1) : null;
  } catch {
    return null;
  }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[c]!);

async function adminBookings(request: Request, url: URL, env: Env): Promise<Response> {
  const token = setting(env, "ADMIN_TOKEN");
  if (!token) return error(404, "Not Found");
  const password = adminPassword(request);
  if (password === null || !whatsapp.safeEqual(password, token)) {
    return error(401, "Not authenticated", { "WWW-Authenticate": "Basic" });
  }
  const client = getClient(url.searchParams.get("client_id") ?? "lamsa");
  if (!client) return error(404, "Unknown client");
  const rows = await getStore(env).listBookings(client.id);
  const cols = ["created_at", "channel", "name", "phone", "service", "date", "time", "stylist", "notes", "status"] as const;

  const cell = (row: BookingRow, col: (typeof cols)[number]) => {
    let value: unknown = row[col];
    if (col === "created_at" && value) {
      // "YYYY-MM-DD HH:MM" in Abu Dhabi time.
      value = new Date(new Date(value as string).getTime() + agent.UAE_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
    }
    return `<td>${escapeHtml(String(value ?? ""))}</td>`;
  };

  const bodyRows = rows.map((r) => "<tr>" + cols.map((c) => cell(r, c)).join("") + "</tr>").join("");
  const empty = rows.length ? "" : "<p>No booking requests yet.</p>";
  const name = escapeHtml(client.name);
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bookings · ${name}</title>
<style>
body{font-family:system-ui,sans-serif;margin:16px;color:#2B2326;background:#FBF7F4}
table{border-collapse:collapse;width:100%;font-size:14px;background:#fff}
th,td{border:1px solid #e6dcd6;padding:6px 8px;text-align:start;vertical-align:top}
th{background:#7A4E5A;color:#fff} .wrap{overflow-x:auto}
</style></head><body>
<h1>${name}: booking requests (${rows.length})</h1>${empty}
<div class="wrap"><table><thead><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr></thead>
<tbody>${bodyRows}</tbody></table></div></body></html>`;
  return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    try {
      switch (route) {
        case "GET /health":
          return json({ ok: true, store: getStore(env).kind });
        case "OPTIONS /chat":
          return new Response(null, { status: 204, headers: corsHeaders(env, request) });
        case "POST /chat":
          return await chat(request, env);
        case "GET /webhook":
          return verifyWebhook(url, env);
        case "POST /webhook":
          return await receiveWebhook(request, env, ctx);
        case "POST /twilio":
          return await receiveTwilio(request, env, ctx);
        case "GET /admin/bookings":
          return await adminBookings(request, url, env);
        default:
          return error(404, "Not Found");
      }
    } catch (e) {
      console.error(`${route} failed: ${e instanceof Error ? e.stack : e}`);
      return error(500, "Internal Server Error", route === "POST /chat" ? corsHeaders(env, request) : {});
    }
  },
} satisfies ExportedHandler<Env>;
