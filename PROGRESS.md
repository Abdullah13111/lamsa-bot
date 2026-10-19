# Progress

## Resume here (2026-10-19)

Rewritten from Python/FastAPI to a Cloudflare Worker in TypeScript (hosting decision 2026-10-19: free
Worker instead of Railway Hobby $5/mo). The Python version is in git history (commit d23bda9).

Verified 2026-10-19: 16 offline tests pass, typecheck clean, and `wrangler dev` against the real Neon DB and
Gemini ran a full Arabic booking (Moroccan bath, "tomorrow 5pm" → 2026-10-20 17:00) that showed on the
admin page. Test rows were deleted afterwards.

Done earlier: GitHub repo `Abdullah13111/lamsa-bot`. Neon project `lamsa-bot` (Singapore, pooled URL in
local `.dev.vars`). Gemini: reuses the Dubai Agent Network key (shared free quota).

LIVE 2026-10-19 at https://lamsa-bot.lamsa-bot.workers.dev (Cloudflare account abdu.saleh92@hotmail.com).
Secrets GEMINI_API_KEY, DATABASE_URL, ADMIN_TOKEN uploaded with `npx wrangler deploy --secrets-file .dev.vars`.
Live check passed: health (postgres), EN + AR chat, CORS for the site, admin 401/200.
Wrangler registered the account's workers.dev subdomain as `lamsa-bot` on first deploy (changeable in
the dashboard under Workers > Subdomain; every worker on the account uses it).

Next:
1. Meta: BLOCKED 2026-10-19. The first app's test WhatsApp account (Lamsa Demo portfolio) was restricted
   permanently ("verify your business", error 131031). A second app reused the same locked account, and
   the Facebook account hit the portfolio creation limit. The user is deleting the apps + portfolio to retry
   later; verification needs a REAL business (Lamsa is fictional; never verify it as Lamsa).
   Bot side is ready: WA_VERIFY_TOKEN secret is set (also in .dev.vars) and verification tested OK.
   When an unrestricted account exists: webhook `https://lamsa-bot.lamsa-bot.workers.dev/webhook`, subscribe
   to `messages`, user puts WA_APP_SECRET + WA_ACCESS_TOKEN in .dev.vars, then
   `npx wrangler deploy --secrets-file .dev.vars`. Fallback: Twilio sandbox adapter (needs a 2nd Twilio
   account; the first one runs the price-compare bot).
2. Done 2026-10-19: site widget enabled (lamsa-website 7f3e351), points at https://lamsa-bot.lamsa-bot.workers.dev/chat;
   the user still needs to try it on a phone.

## Notes

- The old Gemini key in uae-price-compare/start-bot.bat is invalid (401).
- Gemini 2.5 Flash free tier is ~20 requests/day; the bot steps down to flash-lite models on 429.
- Workers free plan: 100k requests/day, 10 ms CPU per request (waiting on Gemini/Neon does not count).
- WhatsApp retries are de-duplicated in the `wa_seen` table (a worker keeps no memory between requests).
- Testing Arabic with curl from Git Bash mangles it to `????`; use a Node script instead.
