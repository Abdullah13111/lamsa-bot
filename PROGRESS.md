# Progress

## Resume here (2026-10-19)

Rewritten from Python/FastAPI to a Cloudflare Worker in TypeScript (hosting decision 2026-10-19: free
Worker instead of Railway Hobby $5/mo). The Python version is in git history (commit d23bda9).

Verified 2026-10-19: 16 offline tests pass, typecheck clean, and `wrangler dev` against the real Neon DB and
Gemini ran a full Arabic booking (Moroccan bath, "tomorrow 5pm" → 2026-10-20 17:00) that showed on the
admin page. Test rows were deleted afterwards.

Done earlier: GitHub repo `Abdullah13111/lamsa-bot`. Neon project `lamsa-bot` (Singapore, pooled URL in
local `.dev.vars`). Gemini: reuses the Dubai Agent Network key (shared free quota).

Next:
1. `npx wrangler login` (expired), then `wrangler secret put` GEMINI_API_KEY, DATABASE_URL, ADMIN_TOKEN,
   then `npm run deploy`. URL will be `https://lamsa-bot.<account>.workers.dev`.
2. Meta: WhatsApp Cloud API app, test number, webhook `https://<worker-url>/webhook`, subscribe to
   `messages`; then `wrangler secret put` WA_VERIFY_TOKEN, WA_APP_SECRET, WA_ACCESS_TOKEN.
3. Website: set `CHAT_ENABLED = true` and `CHAT_API_URL = "https://<worker-url>/chat"` in
   lamsa-website `src/config.ts`.

## Notes

- The old Gemini key in uae-price-compare/start-bot.bat is invalid (401).
- Gemini 2.5 Flash free tier is ~20 requests/day; the bot steps down to flash-lite models on 429.
- Workers free plan: 100k requests/day, 10 ms CPU per request (waiting on Gemini/Neon does not count).
- WhatsApp retries are de-duplicated in the `wa_seen` table (a worker keeps no memory between requests).
- Testing Arabic with curl from Git Bash mangles it to `????`; use a Node script instead.
