-- Times are UTC ISO strings ("2026-10-20T13:05:00Z") so they sort and parse cleanly.
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX messages_session_idx ON messages (client_id, session_id, id);
CREATE INDEX messages_channel_idx ON messages (channel, role, created_at);

CREATE TABLE bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX bookings_client_idx ON bookings (client_id, id);

-- Meta retries webhooks it thinks failed; a worker has no memory between requests.
CREATE TABLE wa_seen (
  message_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
