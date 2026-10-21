-- Shared Twilio sandbox: which bot each WhatsApp number talks to ("lamsa" or "forward").
-- Numbers with no row go to the forward bot (TWILIO_FORWARD_URL).
CREATE TABLE wa_routes (
  sender TEXT PRIMARY KEY,
  bot TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
