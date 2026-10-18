# Progress

## Resume here (2026-10-18)

Built and tested locally (15 tests pass, live Gemini chats in Arabic and English work, booking saved).

Next:
Done: GitHub repo `Abdullah13111/lamsa-bot` (pushed). Neon project `lamsa-bot` (Singapore, pooled URL in
local `.env`), tables created, end-to-end chat + booking verified 2026-10-18. Gemini: the user chose to reuse
the Dubai Agent Network key (shared free quota).

1. Hosting (decide 2026-10-19): Railway free plan is full (2 DAN projects). Options: Railway Hobby $5/mo
   (deploys as-is) or rewrite as a Cloudflare Worker in TS (free; needs `npx wrangler login`, token expired).
2. Deploy: new project + service from the repo, variables, public domain.
3. Meta: WhatsApp Cloud API app, test number, webhook `https://<railway-domain>/webhook`, subscribe to `messages`.
4. Website: set `CHAT_ENABLED = true` and `CHAT_API_URL = "https://<railway-domain>/chat"` in
   lamsa-website `src/config.ts`.

## Notes

- The old Gemini key in uae-price-compare/start-bot.bat is invalid (401).
- Gemini 2.5 Flash free tier is ~20 requests/day; the bot steps down to flash-lite models on 429.
