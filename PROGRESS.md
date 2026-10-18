# Progress

## Resume here (2026-10-18)

Built and tested locally (15 tests pass, live Gemini chats in Arabic and English work, booking saved).

Next:
1. Private GitHub repo `Abdullah13111/lamsa-bot`, push.
2. Neon project for the bot; Gemini key of its own (don't share Dubai Agent Network's quota).
3. Railway: new project + service from the repo, variables, public domain.
4. Meta: WhatsApp Cloud API app, test number, webhook `https://<railway-domain>/webhook`, subscribe to `messages`.
5. Website: set `CHAT_ENABLED = true` and `CHAT_API_URL = "https://<railway-domain>/chat"` in
   lamsa-website `src/config.ts`.

## Notes

- The old Gemini key in uae-price-compare/start-bot.bat is invalid (401).
- Gemini 2.5 Flash free tier is ~20 requests/day; the bot steps down to flash-lite models on 429.
