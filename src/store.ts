/**
 * Conversation history, booking requests and seen WhatsApp message ids.
 *
 * Postgres (Neon, over HTTP) when DATABASE_URL is set; otherwise an in-memory
 * store so the bot runs locally and in tests with no database.
 */
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
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
  kind: "memory" | "postgres";
  addMessage(clientId: string, sessionId: string, channel: string, role: string, content: string): Promise<void>;
  history(clientId: string, sessionId: string, limit: number): Promise<Message[]>;
  /** Customer messages on a channel in the last `minutes`, for all clients. */
  countUserMessages(channel: string, minutes: number): Promise<number>;
  addBooking(clientId: string, sessionId: string, channel: string, booking: Booking): Promise<void>;
  lastBooking(clientId: string, sessionId: string): Promise<BookingRow | null>;
  listBookings(clientId: string, limit?: number): Promise<BookingRow[]>;
  /** Records a WhatsApp message id. False if it was already recorded. */
  markSeen(messageId: string): Promise<boolean>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    client_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (client_id, session_id, id)`,
  `CREATE TABLE IF NOT EXISTS bookings (
    id BIGSERIAL PRIMARY KEY,
    client_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    service TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    stylist TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS bookings_client_idx ON bookings (client_id, created_at DESC)`,
  // Meta retries webhooks it thinks failed; a worker has no memory between requests.
  `CREATE TABLE IF NOT EXISTS wa_seen (
    message_id TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
];

export class MemoryStore implements Store {
  kind = "memory" as const;
  private messages = new Map<string, (Message & { channel: string; at: number })[]>();
  private bookings: BookingRow[] = [];
  private seen = new Set<string>();

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

  async markSeen(messageId: string) {
    if (this.seen.has(messageId)) return false;
    this.seen.add(messageId);
    return true;
  }
}

export class PostgresStore implements Store {
  kind = "postgres" as const;
  private sql: NeonQueryFunction<false, false>;
  private ready: Promise<unknown> | null = null;

  constructor(url: string) {
    this.sql = neon(url);
  }

  /** Creates the tables once per worker instance; retried if it fails. */
  private async q(text: string, params: unknown[] = []): Promise<any[]> {
    this.ready ??= this.sql.transaction(SCHEMA.map((s) => this.sql.query(s))).catch((e) => {
      this.ready = null;
      throw e;
    });
    await this.ready;
    return this.sql.query(text, params);
  }

  async addMessage(clientId: string, sessionId: string, channel: string, role: string, content: string) {
    await this.q(
      "INSERT INTO messages (client_id, session_id, channel, role, content) VALUES ($1, $2, $3, $4, $5)",
      [clientId, sessionId, channel, role, content],
    );
  }

  async history(clientId: string, sessionId: string, limit: number) {
    return (await this.q(
      "SELECT role, content FROM (" +
        "  SELECT id, role, content FROM messages" +
        "  WHERE client_id = $1 AND session_id = $2 ORDER BY id DESC LIMIT $3" +
        ") t ORDER BY id",
      [clientId, sessionId, limit],
    )) as Message[];
  }

  async countUserMessages(channel: string, minutes: number) {
    const rows = await this.q(
      "SELECT count(*)::int AS n FROM messages " +
        "WHERE role = 'user' AND channel = $1 AND created_at > now() - make_interval(mins => $2)",
      [channel, minutes],
    );
    return rows[0].n as number;
  }

  async addBooking(clientId: string, sessionId: string, channel: string, booking: Booking) {
    const placeholders = BOOKING_FIELDS.map((_, i) => `$${i + 4}`).join(", ");
    await this.q(
      `INSERT INTO bookings (client_id, session_id, channel, ${BOOKING_FIELDS.join(", ")}) ` +
        `VALUES ($1, $2, $3, ${placeholders})`,
      [clientId, sessionId, channel, ...BOOKING_FIELDS.map((f) => booking[f] ?? null)],
    );
  }

  async lastBooking(clientId: string, sessionId: string) {
    const rows = await this.q(
      "SELECT * FROM bookings WHERE client_id = $1 AND session_id = $2 ORDER BY id DESC LIMIT 1",
      [clientId, sessionId],
    );
    return (rows[0] as BookingRow) ?? null;
  }

  async listBookings(clientId: string, limit = 200) {
    return (await this.q("SELECT * FROM bookings WHERE client_id = $1 ORDER BY id DESC LIMIT $2", [
      clientId,
      limit,
    ])) as BookingRow[];
  }

  async markSeen(messageId: string) {
    const rows = await this.q(
      "INSERT INTO wa_seen (message_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING message_id",
      [messageId],
    );
    return rows.length > 0;
  }
}

// One store per worker instance (and per DATABASE_URL).
const stores = new Map<string, Store>();

export function getStore(databaseUrl = ""): Store {
  let store = stores.get(databaseUrl);
  if (!store) {
    store = databaseUrl ? new PostgresStore(databaseUrl) : new MemoryStore();
    stores.set(databaseUrl, store);
  }
  return store;
}

/** Tests only: forget the in-memory data. */
export function resetStores() {
  stores.clear();
}
