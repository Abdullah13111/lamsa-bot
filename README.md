# Lamsa bot

AI booking assistant for salons. One Cloudflare Worker answers on **WhatsApp** (Meta Cloud API) and in the
**website chat widget**, using Gemini, with chats and bookings in Cloudflare D1. Lamsa Beauty Lounge is the first (fictional) client; its knowledge
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
npm install
cp .dev.vars.example .dev.vars   # add GEMINI_API_KEY at least
npm run db:migrate:local         # creates the tables in a local D1 copy
npm run dev                      # http://localhost:8787
npm test
npm run typecheck
```

`npm run dev` uses a local D1 copy in `.wrangler/`. The tests use an in-memory store instead.

## Add another salon

1. Copy `clients/lamsa.md` to `clients/<id>.md` and rewrite the facts. The first line is the salon name.
2. Import it in `src/clients.ts` and add it to `KNOWLEDGE`.
3. The website widget sends `client_id: "<id>"`.
4. WhatsApp: one number per deployment for now (`WA_CLIENT_ID` in `wrangler.jsonc`).

## Deploy

```sh
npx wrangler login
npm run db:migrate                        # after adding a file to migrations/
npx wrangler deploy --secrets-file .dev.vars   # uploads GEMINI_API_KEY, ADMIN_TOKEN, WA_* too
```

Plain settings (model, Graph API version, allowed sites) are `vars` in `wrangler.jsonc`. The chat is
limited to 6 messages a minute per visitor (Cloudflare rate limit binding) and 300 an hour in total.
