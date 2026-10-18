"""Conversation history and booking requests.

Postgres (Neon) when DATABASE_URL is set; otherwise an in-memory store so the
bot runs locally and in tests with no database.
"""
import threading
from datetime import datetime, timezone
from functools import lru_cache

from . import config

BOOKING_FIELDS = ["name", "phone", "service", "date", "time", "stylist", "notes"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    client_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (client_id, session_id, id);

CREATE TABLE IF NOT EXISTS bookings (
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
);
CREATE INDEX IF NOT EXISTS bookings_client_idx ON bookings (client_id, created_at DESC);
"""


class MemoryStore:
    kind = "memory"

    def __init__(self):
        self._lock = threading.Lock()
        self._messages: dict[tuple[str, str], list[dict]] = {}
        self._bookings: list[dict] = []

    def add_message(self, client_id, session_id, channel, role, content):
        with self._lock:
            self._messages.setdefault((client_id, session_id), []).append(
                {"role": role, "content": content}
            )

    def history(self, client_id, session_id, limit):
        with self._lock:
            return list(self._messages.get((client_id, session_id), [])[-limit:])

    def add_booking(self, client_id, session_id, channel, booking):
        row = {f: booking.get(f) for f in BOOKING_FIELDS}
        row.update(
            id=len(self._bookings) + 1,
            client_id=client_id,
            session_id=session_id,
            channel=channel,
            status="new",
            created_at=datetime.now(timezone.utc),
        )
        with self._lock:
            self._bookings.append(row)

    def last_booking(self, client_id, session_id):
        with self._lock:
            for row in reversed(self._bookings):
                if row["client_id"] == client_id and row["session_id"] == session_id:
                    return row
        return None

    def list_bookings(self, client_id, limit=200):
        with self._lock:
            rows = [r for r in self._bookings if r["client_id"] == client_id]
        return list(reversed(rows))[:limit]


class PostgresStore:
    kind = "postgres"

    def __init__(self, url: str):
        from psycopg.rows import dict_row
        from psycopg_pool import ConnectionPool

        # Neon closes idle connections when it scales to zero; check= replaces
        # dead ones before they are handed out.
        self.pool = ConnectionPool(
            url,
            min_size=1,
            max_size=5,
            kwargs={"autocommit": True, "row_factory": dict_row},
            check=ConnectionPool.check_connection,
            open=True,
        )
        with self.pool.connection() as conn:
            conn.execute(SCHEMA)

    def add_message(self, client_id, session_id, channel, role, content):
        with self.pool.connection() as conn:
            conn.execute(
                "INSERT INTO messages (client_id, session_id, channel, role, content) "
                "VALUES (%s, %s, %s, %s, %s)",
                (client_id, session_id, channel, role, content),
            )

    def history(self, client_id, session_id, limit):
        with self.pool.connection() as conn:
            rows = conn.execute(
                "SELECT role, content FROM ("
                "  SELECT id, role, content FROM messages"
                "  WHERE client_id = %s AND session_id = %s ORDER BY id DESC LIMIT %s"
                ") t ORDER BY id",
                (client_id, session_id, limit),
            ).fetchall()
        return rows

    def add_booking(self, client_id, session_id, channel, booking):
        with self.pool.connection() as conn:
            conn.execute(
                "INSERT INTO bookings (client_id, session_id, channel, "
                + ", ".join(BOOKING_FIELDS)
                + ") VALUES (%s, %s, %s, "
                + ", ".join(["%s"] * len(BOOKING_FIELDS))
                + ")",
                (client_id, session_id, channel, *[booking.get(f) for f in BOOKING_FIELDS]),
            )

    def last_booking(self, client_id, session_id):
        with self.pool.connection() as conn:
            return conn.execute(
                "SELECT * FROM bookings WHERE client_id = %s AND session_id = %s "
                "ORDER BY id DESC LIMIT 1",
                (client_id, session_id),
            ).fetchone()

    def list_bookings(self, client_id, limit=200):
        with self.pool.connection() as conn:
            return conn.execute(
                "SELECT * FROM bookings WHERE client_id = %s ORDER BY id DESC LIMIT %s",
                (client_id, limit),
            ).fetchall()


@lru_cache
def get_store():
    if config.DATABASE_URL:
        return PostgresStore(config.DATABASE_URL)
    return MemoryStore()
