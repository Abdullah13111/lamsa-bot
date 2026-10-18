# Lamsa bot

AI booking assistant for salons. One FastAPI service answers on **WhatsApp** (Meta Cloud API) and in the
**website chat widget**, using Gemini. Lamsa Beauty Lounge is the first (fictional) client; its knowledge
lives in `clients/lamsa.md`.

## What it does

- Answers questions about services, prices, hours, policies and offers, only from the client file.
- Replies in the customer's language (Arabic or English) and follows a switch mid-chat.
- Collects booking requests (name, mobile, service, date, time, stylist) and checks opening hours and
  service length, confirms a summary, then saves the request for the salon to confirm.
- Shows saved requests at `/admin/bookings` (browser password prompt, password = `ADMIN_TOKEN`).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness check, shows the storage type |
| POST | `/chat` | Website widget: `{client_id, message, session_id}` → `{reply}` |
| GET | `/webhook` | Meta webhook verification (`WA_VERIFY_TOKEN`) |
| POST | `/webhook` | Incoming WhatsApp messages (signed with `WA_APP_SECRET`) |
| GET | `/admin/bookings?client_id=lamsa` | Booking requests table |

## Run locally

```sh
py -3.13 -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt
cp .env.example .env        # add GEMINI_API_KEY at least
.venv/Scripts/python -m uvicorn app.main:app --reload --port 8765
.venv/Scripts/python -m pytest -q
```

Without `DATABASE_URL` it stores chats and bookings in memory (lost on restart).

## Add another salon

1. Copy `clients/lamsa.md` to `clients/<id>.md` and rewrite the facts. The first line is the salon name.
2. The website widget sends `client_id: "<id>"`.
3. WhatsApp: one number per deployment for now (`WA_CLIENT_ID`).

## Deploy

Railway runs `railway.json` (uvicorn, health check on `/health`). Set the variables from `.env.example`.
