/**
 * Conversation history, booking requests and seen WhatsApp message ids.
 *
 * Cloudflare D1 when the DB binding exists; otherwise an in-memory store so the
 * tests run with no database. Tables come from migrations/ (wrangler d1 migrations apply).
 */
import type { Env } from "./env";
import type { Booking } from "./llm";

export const BOOKING_FIELDS = ["name", "phone", "service", "date", "time", "stylist", "notes"] as const;

export interface Message {
  role: string;
  content: string;
}

export interface BookingRow extends Booking {
  id: number;
  client_id: string;
  session_id: string;
  channel: string;
  status: string;
  created_at: Date | string;
}

export interface Store {
  kind: "memory" | "d1";
  addMessage(clientId: string, sessionId: string, channel: string, role: string, content: string): Promise<void>;
  history(clientId: string, sessionId: string, limit: number): Promise<Message[]>;
  /** Customer messages on a channel in the last `minutes`, for all clients. */
  countUserMessages(channel: string, minutes: number): Promise<number>;
  addBooking(clientId: string, sessionId: string, channel: string, booking: Booking): Promise<void>;
  lastBooking(clientId: string, sessionId: string): Promise<BookingRow | null>;
  listBookings(clientId: string, limit?: number): Promise<BookingRow[]>;
  /** Admin confirm/cancel. The updated row, or null if the booking doesn't exist. */
  setBookingStatus(clientId: string, id: number, status: string): Promise<BookingRow | null>;
  /** Records a WhatsApp message id. False if it was already recorded. */
  markSeen(messageId: string): Promise<boolean>;
  /** Shared Twilio sandbox: the bot a WhatsApp number picked, or null if it never picked. */
  getRoute(sender: string): Promise<string | null>;
  setRoute(sender: string, bot: string): Promise<void>;
}

export class MemoryStore implements Store {
  kind = "memory" as const;
  private messages = new Map<string, (Message & { channel: string; at: number })[]>();
  private bookings: BookingRow[] = [];
  private seen = new Set<string>();
  private routes = new Map<string, string>();

  async addMessage(clientId: string, sessionId: string, channel: string, role: string, content: string) {
    const key = `${clientId}\n${sessionId}`;
    if (!this.messages.has(key)) this.messages.set(key, []);
    this.messages.get(key)!.push({ role, content, channel, at: Date.now() });
  }

  async history(clientId: string, sessionId: string, limit: number) {
    const rows = this.messages.get(`${clientId}\n${sessionId}`) ?? [];
    return rows.slice(-limit).map(({ role, content }) => ({ role, content }));
  }

  async countUserMessages(channel: string, minutes: number) {
    const since = Date.now() - minutes * 60_000;
    let n = 0;
    for (const rows of this.messages.values()) {
      n += rows.filter((m) => m.role === "user" && m.channel === channel && m.at >= since).length;
    }
    return n;
  }

  async addBooking(clientId: string, sessionId: string, channel: string, booking: Booking) {
    const row = Object.fromEntries(BOOKING_FIELDS.map((f) => [f, booking[f] ?? null])) as unknown as Booking;
    this.bookings.push({
      ...row,
      id: this.bookings.length + 1,
      client_id: clientId,
      session_id: sessionId,
      channel,
      status: "new",
      created_at: new Date(),
    });
  }

  async lastBooking(clientId: string, sessionId: string) {
    for (let i = this.bookings.length - 1; i >= 0; i--) {
      const row = this.bookings[i];
      if (row.client_id === clientId && row.session_id === sessionId) return row;
    }
    return null;
  }

  async listBookings(clientId: string, limit = 200) {
    return this.bookings.filter((r) => r.client_id === clientId).reverse().slice(0, limit);
  }

  async setBookingStatus(clientId: string, id: number, status: string) {
    const row = this.bookings.find((r) => r.client_id === clientId && r.id === id);
    if (!row) return null;
    row.status = status;
    return row;
  }

  async markSeen(messageId: string) {
    if (this.seen.has(messageId)) return false;
    this.seen.add(messageId);
    return true;
  }

  async getRoute(sender: string) {
    return this.routes.get(sender) ?? null;
  }

  async setRoute(sender: string, bot: string) {
    this.routes.set(sender, bot);
  }
}

export class D1Store implements Store {
  kind = "d1" as const;

  constructor(private db: D1Database) {}

  async addMessage(clientId: string, sessionId: string, channel: string, role: string, content: string) {
    await this.db
      .prepare("INSERT INTO messages (client_id, session_id, channel, role, content) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(clientId, sessionId, channel, role, content)
      .run();
  }

  async history(clientId: string, sessionId: string, limit: number) {
    const { results } = await this.db
      .prepare(
        "SELECT role, content FROM (" +
          "  SELECT id, role, content FROM messages" +
          "  WHERE client_id = ?1 AND session_id = ?2 ORDER BY id DESC LIMIT ?3" +
          ") ORDER BY id",
      )
      .bind(clientId, sessionId, limit)
      .all<Message>();
    return results;
  }

  async countUserMessages(channel: string, minutes: number) {
    const n = await this.db
      .prepare(
        "SELECT count(*) AS n FROM messages WHERE role = 'user' AND channel = ?1 " +
          "AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-' || ?2 || ' minutes')",
      )
      .bind(channel, minutes)
      .first<number>("n");
    return n ?? 0;
  }

  async addBooking(clientId: string, sessionId: string, channel: string, booking: Booking) {
    const placeholders = BOOKING_FIELDS.map((_, i) => `?${i + 4}`).join(", ");
    await this.db
      .prepare(
        `INSERT INTO bookings (client_id, session_id, channel, ${BOOKING_FIELDS.join(", ")}) ` +
          `VALUES (?1, ?2, ?3, ${placeholders})`,
      )
      .bind(clientId, sessionId, channel, ...BOOKING_FIELDS.map((f) => booking[f] ?? null))
      .run();
  }

  async lastBooking(clientId: string, sessionId: string) {
    return this.db
      .prepare("SELECT * FROM bookings WHERE client_id = ?1 AND session_id = ?2 ORDER BY id DESC LIMIT 1")
      .bind(clientId, sessionId)
      .first<BookingRow>();
  }

  async listBookings(clientId: string, limit = 200) {
    const { results } = await this.db
      .prepare("SELECT * FROM bookings WHERE client_id = ?1 ORDER BY id DESC LIMIT ?2")
      .bind(clientId, limit)
      .all<BookingRow>();
    return results;
  }

  async setBookingStatus(clientId: string, id: number, status: string) {
    return this.db
      .prepare("UPDATE bookings SET status = ?3 WHERE client_id = ?1 AND id = ?2 RETURNING *")
      .bind(clientId, id, status)
      .first<BookingRow>();
  }

  async markSeen(messageId: string) {
    const { meta } = await this.db
      .prepare("INSERT INTO wa_seen (message_id) VALUES (?1) ON CONFLICT DO NOTHING")
      .bind(messageId)
      .run();
    return meta.changes > 0;
  }

  async getRoute(sender: string) {
    return this.db.prepare("SELECT bot FROM wa_routes WHERE sender = ?1").bind(sender).first<string>("bot");
  }

  async setRoute(sender: string, bot: string) {
    await this.db
      .prepare(
        "INSERT INTO wa_routes (sender, bot) VALUES (?1, ?2) " +
          "ON CONFLICT (sender) DO UPDATE SET bot = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')",
      )
      .bind(sender, bot)
      .run();
  }
}

// Without D1 (tests), one in-memory store per worker instance.
let memory: MemoryStore | null = null;

export function getStore(env: Env): Store {
  if (env.DB) return new D1Store(env.DB);
  return (memory ??= new MemoryStore());
}

/** Tests only: forget the in-memory data. */
export function resetStores() {
  memory = null;
}
