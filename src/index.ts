/** HTTP entry points: web chat, WhatsApp webhooks (Meta, Twilio), bookings admin page. */
import * as agent from "./agent";
import { type Client, getClient } from "./clients";
import { type Env, setting } from "./env";
import { getStore, type BookingRow } from "./store";
import * as twilio from "./twilio";
import * as whatsapp from "./whatsapp";

// Ceiling for all web visitors together, in case per-IP limits are dodged.
const WEB_TOTAL_PER_HOUR = 300;

const UNSUPPORTED_REPLY =
  "أقدر أقرأ الرسائل النصية بس حالياً، اكتبي لي سؤالك لو سمحتي.\n" +
  "I can only read text messages for now. Please type your question.";

// Shared Twilio sandbox (TWILIO_FORWARD_URL): replies to the switch words.
const LAMSA_WELCOME =
  "أهلاً بك في لمسة 💜 اسألي عن الخدمات والأسعار أو احجزي موعدك.\n" +
  "Welcome to Lamsa Beauty Lounge 💜 Ask about services and prices, or book an appointment.\n\n" +
  "(Send *price* to go back to the price-compare bot.)";
const FORWARD_WELCOME =
  "Back to the price-compare bot. Send a product name or an Amazon.ae/Noon link.\n" +
  "(Send *lamsa* for the salon bot.)";
const FORWARD_OFFLINE =
  "The price-compare bot is offline right now. Send *lamsa* to try the Lamsa salon bot.";

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
  const msg = twilio.parse(params);
  const forwardUrl = setting(env, "TWILIO_FORWARD_URL");
  if (msg && forwardUrl) {
    const store = getStore(env);
    const command = twilio.routeCommand(msg.text);
    if (command) {
      await store.setRoute(msg.sender, command);
      return twilio.twiml(command === "lamsa" ? LAMSA_WELCOME : FORWARD_WELCOME);
    }
    if ((await store.getRoute(msg.sender)) !== "lamsa") return twilio.forward(forwardUrl, params, FORWARD_OFFLINE);
  }
  // Empty TwiML now, the reply follows by API, so a slow model can't hit Twilio's 15 s timeout.
  if (msg) ctx.waitUntil(handleWhatsapp(env, msg, twilio.sendText));
  return twilio.twiml();
}

type Send = (env: Env, from: string, to: string, body: string) => Promise<unknown>;

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

/** An error response unless the request has the admin password. */
function adminDenied(request: Request, env: Env): Response | null {
  const token = setting(env, "ADMIN_TOKEN");
  if (!token) return error(404, "Not Found");
  const password = adminPassword(request);
  if (password === null || !whatsapp.safeEqual(password, token)) {
    return error(401, "Not authenticated", { "WWW-Authenticate": "Basic" });
  }
  return null;
}

const BOOKING_ACTIONS: Record<string, string> = { confirmed: "Confirm", cancelled: "Cancel" };

function bookingUpdateText(client: Client, row: BookingRow): string {
  const day = (locale: string) =>
    new Date(`${row.date}T00:00:00Z`).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const when = { ar: `${day("ar-AE")} الساعة ${row.time}`, en: `${day("en-GB")} at ${row.time}` };
  if (row.status === "confirmed") {
    return (
      `✅ ${client.name}\n` +
      `تم تأكيد موعدك: ${row.service}، ${when.ar}. نشوفك قريب 💜\n` +
      `Your appointment is confirmed: ${row.service}, ${when.en}. See you soon!`
    );
  }
  return (
    `${client.name}\n` +
    `نعتذر، ما قدرنا نثبّت موعدك (${row.service}، ${when.ar}). ردّي على هالرسالة ونرتب لك وقت ثاني.\n` +
    `Sorry, we couldn't keep your appointment (${row.service}, ${when.en}). Reply here and we'll find another time.`
  );
}

/** Tells the customer about a confirm/cancel. Returns a note for the admin page. */
async function notifyCustomer(env: Env, client: Client, row: BookingRow): Promise<string> {
  if (!row.session_id.startsWith("wa:")) return `Not messaged: booked on ${row.channel}. Call ${row.phone}.`;
  const from = setting(env, "TWILIO_WHATSAPP_FROM");
  if (!from || !setting(env, "TWILIO_AUTH_TOKEN")) return `Not messaged: Twilio WhatsApp isn't set up. Call ${row.phone}.`;
  const text = bookingUpdateText(client, row);
  if (!(await twilio.sendText(env, from, row.session_id.slice(3), text))) {
    return `WhatsApp message failed (over 24 h since their last message?). Call ${row.phone}.`;
  }
  // So the bot knows what the customer is replying to.
  await getStore(env).addMessage(client.id, row.session_id, "whatsapp", "model", text);
  return "Customer told on WhatsApp.";
}

async function updateBooking(request: Request, url: URL, env: Env): Promise<Response> {
  const denied = adminDenied(request, env);
  if (denied) return denied;
  // A browser sends saved Basic credentials with any site's form post, so only accept our own page.
  if (request.headers.get("Origin") !== url.origin) return error(403, "Bad origin");
  const form = await request.formData();
  const client = getClient(String(form.get("client_id") ?? "lamsa"));
  const status = String(form.get("status") ?? "");
  const id = Number(form.get("id"));
  if (!client || !(status in BOOKING_ACTIONS) || !Number.isInteger(id)) return error(422, "Invalid request");
  const row = await getStore(env).setBookingStatus(client.id, id, status);
  if (!row) return error(404, "Unknown booking");
  const note = `Booking ${id} ${status}. ${await notifyCustomer(env, client, row)}`;
  const back = new URL("/admin/bookings", url);
  back.searchParams.set("client_id", client.id);
  back.searchParams.set("note", note);
  return Response.redirect(back.toString(), 303);
}

async function adminBookings(request: Request, url: URL, env: Env): Promise<Response> {
  const denied = adminDenied(request, env);
  if (denied) return denied;
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

  const actions = (row: BookingRow) =>
    "<td>" +
    Object.entries(BOOKING_ACTIONS)
      .filter(([status]) => status !== row.status)
      .map(
        ([status, label]) =>
          `<form method="post" action="/admin/bookings/status"><input type="hidden" name="client_id" value="${escapeHtml(client.id)}">` +
          `<input type="hidden" name="id" value="${row.id}"><input type="hidden" name="status" value="${status}">` +
          `<button class="${status}">${label}</button></form>`,
      )
      .join("") +
    "</td>";

  const bodyRows = rows.map((r) => "<tr>" + cols.map((c) => cell(r, c)).join("") + actions(r) + "</tr>").join("");
  const empty = rows.length ? "" : "<p>No booking requests yet.</p>";
  const note = url.searchParams.get("note");
  const banner = note ? `<p class="note">${escapeHtml(note)}</p>` : "";
  const name = escapeHtml(client.name);
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bookings · ${name}</title>
<style>
body{font-family:system-ui,sans-serif;margin:16px;color:#2B2326;background:#FBF7F4}
table{border-collapse:collapse;width:100%;font-size:14px;background:#fff}
th,td{border:1px solid #e6dcd6;padding:6px 8px;text-align:start;vertical-align:top}
th{background:#7A4E5A;color:#fff} .wrap{overflow-x:auto}
form{display:inline} button{margin:2px;padding:4px 10px;border:0;border-radius:4px;color:#fff;cursor:pointer}
.confirmed{background:#2E7D4F} .cancelled{background:#A33A3A}
.note{background:#fff;border-inline-start:4px solid #7A4E5A;padding:8px 12px}
</style></head><body>
<h1>${name}: booking requests (${rows.length})</h1>${banner}${empty}
<div class="wrap"><table><thead><tr>${cols.map((c) => `<th>${c}</th>`).join("")}<th></th></tr></thead>
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
        case "POST /admin/bookings/status":
          return await updateBooking(request, url, env);
        default:
          return error(404, "Not Found");
      }
    } catch (e) {
      console.error(`${route} failed: ${e instanceof Error ? e.stack : e}`);
      return error(500, "Internal Server Error", route === "POST /chat" ? corsHeaders(env, request) : {});
    }
  },
} satisfies ExportedHandler<Env>;
