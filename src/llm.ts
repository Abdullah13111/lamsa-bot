/**
 * Gemini call that returns the bot's reply plus an optional booking, as JSON.
 *
 * One request per customer message: structured output (responseSchema) instead
 * of function calling, which would need a second round trip.
 */
import { type Env, setting } from "./env";

// The free tier allows only ~20 gemini-2.5-flash requests a day; the lite
// models allow far more. On a quota 429 (or a 404 when Google retires a model
// name) we step down the chain instead of failing the customer. Same chain as
// the price-compare bot.
export const FALLBACK_MODELS = ["gemini-flash-lite-latest", "gemini-3.1-flash-lite"];

const BOOKING_FIELDS = ["name", "phone", "service", "date", "time"] as const;

export interface Booking {
  name: string;
  phone: string;
  service: string;
  date: string;
  time: string;
  stylist?: string | null;
  notes?: string | null;
}

export interface LLMOutput {
  reply: string;
  booking: Booking | null;
}

export interface Content {
  role: "user" | "model";
  parts: { text: string }[];
}

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    reply: { type: "STRING" },
    booking: {
      type: "OBJECT",
      nullable: true,
      properties: {
        name: { type: "STRING" },
        phone: { type: "STRING" },
        service: { type: "STRING" },
        date: { type: "STRING", description: "YYYY-MM-DD" },
        time: { type: "STRING", description: "HH:MM, 24-hour" },
        stylist: { type: "STRING", nullable: true },
        notes: { type: "STRING", nullable: true },
      },
      required: BOOKING_FIELDS,
    },
  },
  required: ["reply"],
};

export class LLMError extends Error {}

export async function generate(env: Env, system: string, contents: Content[]): Promise<LLMOutput> {
  const apiKey = setting(env, "GEMINI_API_KEY");
  if (!apiKey) throw new LLMError("GEMINI_API_KEY is not set");
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: {
      temperature: 0.4,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });
  const primary = setting(env, "GEMINI_MODEL", "gemini-2.5-flash");
  const models = [primary, ...FALLBACK_MODELS.filter((m) => m !== primary)];
  let lastErr = "";
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    let r: Response;
    try {
      r = await fetch(url, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      lastErr = `${model}: ${e}`;
      continue;
    }
    if (r.status === 404 || r.status === 429 || r.status >= 500) {
      lastErr = `${model} HTTP ${r.status}`;
      console.warn(`Gemini ${lastErr}, trying next model`);
      continue;
    }
    if (r.status !== 200) {
      throw new LLMError(`${model} HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    }
    try {
      const json: any = await r.json();
      const parts: { text?: string }[] = json.candidates[0].content.parts;
      return clean(JSON.parse(parts.map((p) => p.text ?? "").join("")));
    } catch (e) {
      lastErr = `${model} bad response: ${e}`;
    }
  }
  throw new LLMError(lastErr || "no model answered");
}

export function clean(data: any): LLMOutput {
  const reply = String(data?.reply ?? "").trim();
  let booking = data?.booking;
  if (
    !booking ||
    typeof booking !== "object" ||
    !BOOKING_FIELDS.every((f) => String(booking[f] ?? "").trim())
  ) {
    booking = null;
  }
  return { reply, booking };
}
