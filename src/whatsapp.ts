/** WhatsApp Cloud API (Meta): webhook parsing, signature check, sending replies. */
import { type Env, setting } from "./env";

export interface Incoming {
  messageId: string;
  phoneNumberId: string;
  sender: string; // wa_id: international number, digits only
  type: string;
  text: string;
}

const encoder = new TextEncoder();

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Meta signs every webhook POST with the app secret (X-Hub-Signature-256). */
export async function verifySignature(body: ArrayBuffer, header: string | null, secret: string): Promise<boolean> {
  if (!secret || !header) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  const expected = "sha256=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  return safeEqual(expected, header);
}

/** Customer messages in a webhook payload. Delivery/read statuses are skipped. */
export function parse(payload: any): Incoming[] {
  const out: Incoming[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      const phoneNumberId = value.metadata?.phone_number_id ?? "";
      for (const m of value.messages ?? []) {
        const text = m.type === "text" ? (m.text?.body ?? "") : "";
        out.push({
          messageId: m.id ?? "",
          phoneNumberId,
          sender: m.from ?? "",
          type: m.type ?? "",
          text: String(text).trim(),
        });
      }
    }
  }
  return out;
}

export async function sendText(env: Env, phoneNumberId: string, to: string, body: string): Promise<void> {
  const version = setting(env, "WA_GRAPH_VERSION", "v23.0");
  const r = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${setting(env, "WA_ACCESS_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: body.slice(0, 4096) },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status >= 400) console.error(`WhatsApp send failed: HTTP ${r.status} ${(await r.text()).slice(0, 500)}`);
}
