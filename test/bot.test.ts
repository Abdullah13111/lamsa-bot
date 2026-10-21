/** Offline tests: Gemini and the WhatsApp send API are replaced with a fake fetch. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agent from "../src/agent";
import { getClient } from "../src/clients";
import type { Env } from "../src/env";
import worker from "../src/index";
import * as llm from "../src/llm";
import { getStore, MemoryStore, resetStores } from "../src/store";

const BOOKING = {
  name: "Mariam",
  phone: "0501234567",
  service: "Keratin treatment",
  date: "2026-10-20",
  time: "16:00",
  stylist: "Rania",
  notes: null,
};

let llmCalls: { system: string; contents: llm.Content[] }[];
let answers: unknown[];
let sent: { url: string; to: string; body: string }[];
let geminiStatus: number;
let forwarded: URLSearchParams[];
let forwardUp: boolean;

beforeEach(() => {
  resetStores();
  llmCalls = [];
  answers = [];
  sent = [];
  geminiStatus = 200;
  forwarded = [];
  forwardUp = true;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    if (input === "https://price.example/whatsapp") {
      forwarded.push(init.body as URLSearchParams);
      if (!forwardUp) return new Response("ERR_NGROK_3200", { status: 404 });
      return new Response("<Response><Message>Comparing prices</Message></Response>");
    }
    if (input.includes("api.twilio.com")) {
      const form = init.body as URLSearchParams;
      sent.push({ url: input, to: form.get("To")!, body: form.get("Body")! });
      return Response.json({ sid: "SMout" }, { status: 201 });
    }
    const body = JSON.parse(String(init.body));
    if (input.includes("generativelanguage.googleapis.com")) {
      if (geminiStatus !== 200) return new Response("quota", { status: geminiStatus });
      llmCalls.push({ system: body.systemInstruction.parts[0].text, contents: body.contents });
      const answer = answers.length ? answers.shift() : { reply: "Hello!", booking: null };
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] });
    }
    if (input.includes("graph.facebook.com")) {
      sent.push({ url: input, to: body.to, body: body.text.body });
      return Response.json({ messages: [{ id: "wamid.out" }] });
    }
    throw new Error(`unexpected fetch ${input}`);
  });
});

afterEach(() => vi.unstubAllGlobals());

function limiter(limit: number): RateLimit {
  let hits = 0;
  return { limit: async () => ({ success: ++hits <= limit }) };
}

function makeEnv(extra: Partial<Env> = {}): Env {
  return { GEMINI_API_KEY: "test-key", CORS_ORIGINS: "https://site.example", WEB_LIMITER: limiter(100), ...extra };
}

/** Runs the worker and waits for its background work (ctx.waitUntil). */
async function call(env: Env, path: string, init: RequestInit = {}) {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  const res = await worker.fetch(new Request(`https://bot.example${path}`, init) as any, env, ctx);
  await Promise.all(pending);
  return res;
}

const postChat = (env: Env, payload: unknown, headers: Record<string, string> = {}) =>
  call(env, "/chat", { method: "POST", body: JSON.stringify(payload), headers: { "Content-Type": "application/json", ...headers } });

const lamsa = () => getClient("lamsa")!;

it("loads the lamsa client", () => {
  expect(lamsa().name.startsWith("Lamsa Beauty Lounge")).toBe(true);
  expect(lamsa().knowledge).toContain("Keratin treatment");
  expect(getClient("../secrets")).toBeNull();
  expect(getClient("nobody")).toBeNull();
  expect(getClient("constructor")).toBeNull();
});

describe("web chat", () => {
  it("replies and keeps history", async () => {
    answers.push({ reply: "Hi! How can I help?", booking: null }, { reply: "From AED 600.", booking: null });
    const env = makeEnv();
    const payload = { client_id: "lamsa", message: "hello", session_id: "abc123" };
    expect(await (await postChat(env, payload)).json()).toEqual({ reply: "Hi! How can I help?" });
    expect(await (await postChat(env, { ...payload, message: "keratin price?" })).json()).toEqual({ reply: "From AED 600." });
    expect(llmCalls[1].contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(llmCalls[1].system).toContain("Ask for a UAE mobile number");
  });

  it("rejects an unknown client and a long message", async () => {
    const env = makeEnv();
    expect((await postChat(env, { client_id: "x", message: "hi", session_id: "s" })).status).toBe(404);
    expect((await postChat(env, { client_id: "lamsa", message: "a".repeat(1001), session_id: "s" })).status).toBe(422);
    expect((await call(env, "/chat", { method: "POST", body: "not json" })).status).toBe(422);
  });

  it("rate limits per visitor", async () => {
    const env = makeEnv({ WEB_LIMITER: limiter(2) });
    const payload = { client_id: "lamsa", message: "hi", session_id: "s" };
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await postChat(env, payload)).status);
    expect(codes).toEqual([200, 200, 429]);
  });

  it("sends CORS headers only to allowed sites", async () => {
    const env = makeEnv();
    const payload = { client_id: "lamsa", message: "hi", session_id: "s" };
    const ok = await postChat(env, payload, { Origin: "https://site.example" });
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("https://site.example");
    const other = await postChat(env, payload, { Origin: "https://evil.example" });
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const preflight = await call(env, "/chat", { method: "OPTIONS", headers: { Origin: "https://site.example" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toBe("POST");
  });
});

describe("agent", () => {
  it("saves a booking once", async () => {
    answers.push(
      { reply: "Booked, the team will confirm.", booking: { ...BOOKING } },
      { reply: "You're welcome!", booking: { ...BOOKING } }, // model repeats it
    );
    const env = makeEnv();
    await agent.handleMessage(env, lamsa(), "web:s1", "web", "yes confirm");
    await agent.handleMessage(env, lamsa(), "web:s1", "web", "thanks");
    const rows = await getStore(env).listBookings("lamsa");
    expect(rows).toHaveLength(1);
    expect(rows[0].service).toBe("Keratin treatment");
  });

  it("falls back when every model fails", async () => {
    geminiStatus = 429;
    const reply = await agent.handleMessage(makeEnv(), lamsa(), "web:s2", "web", "hi");
    expect(reply).toBe(agent.FALLBACK_REPLY.web);
  });

  it("puts the Abu Dhabi date and WhatsApp number in the prompt", () => {
    const now = new Date("2026-10-18T19:30:00+04:00");
    const prompt = agent.systemPrompt(lamsa(), "whatsapp", "+971501234567", now);
    expect(prompt).toContain("Sunday 18 October 2026, 19:30");
    expect(prompt).toContain("+971501234567");
    expect(prompt).toContain("do not ask for it");
  });

  it("drops an incomplete booking", () => {
    const out = llm.clean({ reply: " hi ", booking: { name: "A", phone: "", service: "x", date: "d", time: "t" } });
    expect(out).toEqual({ reply: "hi", booking: null });
  });

  it("names the latest message's language", async () => {
    const env = makeEnv();
    await agent.handleMessage(env, lamsa(), "web:lang", "web", "كم سعر الحمام المغربي؟");
    await agent.handleMessage(env, lamsa(), "web:lang", "web", "bridal quote please");
    await agent.handleMessage(env, lamsa(), "web:lang", "web", "050 123 4567");
    expect(llmCalls[0].system).toContain("Reply in Arabic only");
    expect(llmCalls[1].system).toContain("Reply in English only");
    expect(llmCalls[2].system).not.toContain("latest message is in");
  });

  it("uses memory storage without a D1 binding", () => {
    expect(getStore(makeEnv())).toBeInstanceOf(MemoryStore);
  });
});

describe("whatsapp webhook", () => {
  it("answers Meta's verification", async () => {
    const env = makeEnv({ WA_VERIFY_TOKEN: "secret-token" });
    const ok = await call(env, "/webhook?hub.mode=subscribe&hub.verify_token=secret-token&hub.challenge=42");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("42");
    const bad = await call(env, "/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42");
    expect(bad.status).toBe(403);
  });

  const waPayload = (messageId = "wamid.1", text = "مرحبا لمسة، أبي أحجز موعد") => ({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: {
      metadata: { phone_number_id: "PNID" },
      contacts: [{ wa_id: "971501234567", profile: { name: "Mariam" } }],
      messages: [{ id: messageId, from: "971501234567", type: "text", text: { body: text } }],
    } }] }],
  });

  async function signedPost(env: Env, payload: unknown, secret = "app-secret") {
    const raw = JSON.stringify(payload);
    if (!secret) return call(env, "/webhook", { method: "POST", body: raw, headers: { "X-Hub-Signature-256": "sha256=" } });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
    const sig = "sha256=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
    return call(env, "/webhook", { method: "POST", body: raw, headers: { "X-Hub-Signature-256": sig, "Content-Type": "application/json" } });
  }

  it("replies once per message", async () => {
    answers.push({ reply: "أهلاً! أي خدمة تبين؟", booking: null });
    const env = makeEnv({ WA_APP_SECRET: "app-secret" });
    expect((await signedPost(env, waPayload())).status).toBe(200);
    expect((await signedPost(env, waPayload())).status).toBe(200); // Meta retry
    expect(sent).toEqual([{ url: "https://graph.facebook.com/v23.0/PNID/messages", to: "971501234567", body: "أهلاً! أي خدمة تبين؟" }]);
    expect(llmCalls[0].system).toContain("+971501234567");
  });

  it("rejects a bad signature", async () => {
    expect((await signedPost(makeEnv({ WA_APP_SECRET: "app-secret" }), waPayload(), "wrong")).status).toBe(403);
    expect((await signedPost(makeEnv({ WA_APP_SECRET: "" }), waPayload(), "")).status).toBe(403);
  });

  it("ignores status updates", async () => {
    const statusOnly = { entry: [{ changes: [{ value: { metadata: { phone_number_id: "PNID" },
      statuses: [{ id: "wamid.9", status: "read" }] } }] }] };
    expect((await signedPost(makeEnv({ WA_APP_SECRET: "app-secret" }), statusOnly)).status).toBe(200);
    expect(sent).toEqual([]);
  });
});

describe("twilio webhook", () => {
  const form = (extra: Record<string, string> = {}) =>
    new URLSearchParams({
      MessageSid: "SM1",
      From: "whatsapp:+971501234567",
      To: "whatsapp:+14155238886",
      Body: "كم سعر الحمام المغربي؟",
      NumMedia: "0",
      ...extra,
    });

  async function signedPost(env: Env, params: URLSearchParams, token = "auth-token") {
    const url = "https://bot.example/twilio";
    const data = url + [...params].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => k + v).join("");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)))));
    return call(env, "/twilio", {
      method: "POST",
      body: params.toString(),
      headers: { "X-Twilio-Signature": sig, "Content-Type": "application/x-www-form-urlencoded" },
    });
  }

  const twilioEnv = () => makeEnv({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "auth-token" });

  it("replies once per message", async () => {
    answers.push({ reply: "250 درهم", booking: null });
    const env = twilioEnv();
    const res = await signedPost(env, form());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<Response/>");
    expect((await signedPost(env, form())).status).toBe(200); // retry
    expect(sent).toEqual([{ url: "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json", to: "whatsapp:+971501234567", body: "250 درهم" }]);
    expect(llmCalls[0].system).toContain("+971501234567");
  });

  it("rejects a bad signature", async () => {
    expect((await signedPost(twilioEnv(), form(), "wrong")).status).toBe(403);
    expect((await signedPost(makeEnv(), form())).status).toBe(403); // no auth token set
    expect(sent).toEqual([]);
  });

  it("answers media with the text-only note", async () => {
    await signedPost(twilioEnv(), form({ Body: "", NumMedia: "1" }));
    expect(llmCalls).toEqual([]);
    expect(sent[0].body).toContain("text messages");
  });

  describe("shared sandbox", () => {
    const sharedEnv = () => makeEnv({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "auth-token", TWILIO_FORWARD_URL: "https://price.example/whatsapp" });

    it("forwards numbers that never picked Lamsa", async () => {
      const res = await signedPost(sharedEnv(), form({ Body: "iphone 16" }));
      expect(await res.text()).toBe("<Response><Message>Comparing prices</Message></Response>");
      expect(forwarded[0].get("Body")).toBe("iphone 16");
      expect(llmCalls).toEqual([]);
    });

    it("switches with lamsa and price", async () => {
      const env = sharedEnv();
      expect(await (await signedPost(env, form({ MessageSid: "SM1", Body: "لمسة" }))).text()).toContain("Lamsa");
      answers.push({ reply: "250 درهم", booking: null });
      expect(await (await signedPost(env, form({ MessageSid: "SM2" }))).text()).toBe("<Response/>");
      expect(sent.map((s) => s.body)).toEqual(["250 درهم"]);
      expect(await (await signedPost(env, form({ MessageSid: "SM3", Body: "Price" }))).text()).toContain("price-compare");
      await signedPost(env, form({ MessageSid: "SM4", Body: "iphone 16" }));
      expect(forwarded.map((f) => f.get("Body"))).toEqual(["iphone 16"]);
    });

    it("says so when the other bot is offline", async () => {
      forwardUp = false;
      const res = await signedPost(sharedEnv(), form({ Body: "iphone 16" }));
      expect(await res.text()).toContain("offline");
    });
  });
});

it("shows bookings on the admin page", async () => {
  answers.push({ reply: "Done", booking: { ...BOOKING } });
  await agent.handleMessage(makeEnv(), lamsa(), "web:s3", "web", "confirm");
  expect((await call(makeEnv({ ADMIN_TOKEN: "" }), "/admin/bookings")).status).toBe(404);
  const env = makeEnv({ ADMIN_TOKEN: "pw" });
  expect((await call(env, "/admin/bookings")).status).toBe(401);
  const page = await call(env, "/admin/bookings", { headers: { Authorization: `Basic ${btoa("admin:pw")}` } });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("Mariam");
  expect(html).toContain("Keratin treatment");
});

describe("admin confirm/cancel", () => {
  const auth = { Authorization: `Basic ${btoa("admin:pw")}` };
  const adminEnv = () =>
    makeEnv({ ADMIN_TOKEN: "pw", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "auth-token", TWILIO_WHATSAPP_FROM: "whatsapp:+14155238886" });
  const post = (env: Env, status: string, headers: Record<string, string> = { ...auth, Origin: "https://bot.example" }) =>
    call(env, "/admin/bookings/status", {
      method: "POST",
      body: new URLSearchParams({ client_id: "lamsa", id: "1", status }),
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    });

  it("confirms a WhatsApp booking and tells the customer", async () => {
    const env = adminEnv();
    answers.push({ reply: "Done", booking: { ...BOOKING } });
    await agent.handleMessage(env, lamsa(), "wa:971501234567", "whatsapp", "confirm", "+971501234567");
    const res = await post(env, "confirmed");
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("Location")!).searchParams.get("note")).toContain("told on WhatsApp");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("whatsapp:+971501234567");
    expect(sent[0].body).toContain("confirmed: Keratin treatment, Tuesday 20 October at 16:00");
    expect((await getStore(env).listBookings("lamsa"))[0].status).toBe("confirmed");
    const history = await getStore(env).history("lamsa", "wa:971501234567", 10);
    expect(history.at(-1)!.content).toBe(sent[0].body);
  });

  it("cancels a web booking without messaging", async () => {
    const env = adminEnv();
    answers.push({ reply: "Done", booking: { ...BOOKING } });
    await agent.handleMessage(env, lamsa(), "web:s1", "web", "confirm");
    const res = await post(env, "cancelled");
    expect(new URL(res.headers.get("Location")!).searchParams.get("note")).toContain("Call 0501234567");
    expect(sent).toEqual([]);
    expect((await getStore(env).listBookings("lamsa"))[0].status).toBe("cancelled");
  });

  it("needs the password and our own page", async () => {
    const env = adminEnv();
    expect((await post(env, "confirmed", { Origin: "https://bot.example" })).status).toBe(401);
    expect((await post(env, "confirmed", { ...auth, Origin: "https://evil.example" })).status).toBe(403);
    expect((await post(env, "deleted")).status).toBe(422);
    expect((await post(env, "confirmed")).status).toBe(404); // no booking 1 yet
  });
});
