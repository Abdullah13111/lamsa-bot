# Progress

## Resume here (2026-10-21)

WhatsApp now runs on the price-compare bot's Twilio sandbox (shared; first Twilio account, created
2026-07-05, classic sandbox +1 415 523 8886, join code "join chosen-standard"). A 2nd Twilio trial made
2026-10-21 got Twilio's NEW "Try out WhatsApp" (+1 737 250 8034, "join twilio-trial") which has NO
webhook setting without upgrading, so it is unused.

How it works: the sandbox webhook points at the Worker (/twilio). Numbers go to the price bot
(TWILIO_FORWARD_URL = the ngrok /whatsapp URL, forwarded and its TwiML returned) unless they send
"lamsa"/"لمسة"; "price"/"أسعار" switches back. Choices live in D1 `wa_routes` (migration 0002).
If the PC/ngrok is off, the price route answers "offline, send lamsa". .dev.vars TWILIO_* now hold the
FIRST account's SID + token (needed to verify signatures and reply). Deployed + live-tested with signed
requests 2026-10-21 (22 tests pass).

Waiting on the user:
1. Log in to the price-compare Twilio account > Messaging > Try it out > Send a WhatsApp message >
   Sandbox settings: "When a message comes in" = https://lamsa-bot.lamsa-bot.workers.dev/twilio (POST), save.
   (Before it was https://gigolo-excavator-revert.ngrok-free.dev/whatsapp; put that back to undo.)
2. From the phone joined to that sandbox (rejoin with "join chosen-standard" if it expired), send "lamsa",
   then an Arabic booking; check /admin/bookings and `npx wrangler tail`.
3. Later: point the site's WhatsApp buttons at the sandbox, or keep the salon number.
4. Optional: delete the unused Neon project `lamsa-bot` and the unused 2nd Twilio trial.

## Earlier (2026-10-20)

Database moved from Neon to Cloudflare D1 (2026-10-20, Neon had no real data): D1 `lamsa-bot`
(APAC, id dac7e6bb-01d9-4bc9-99d5-29d31633c143, binding `DB`). Tables are in `migrations/`, applied
with `npm run db:migrate`. Deployed, the DATABASE_URL secret was deleted, and a live Arabic chat saved
to D1 (test rows deleted). The Neon project `lamsa-bot` is unused now and can be deleted in the Neon console.

Meta retry 2026-10-20: new app (id 1446637624231173) on portfolio "Abdullahdemo", but it reused the test
WhatsApp account 1646379573557292 (number +1 555 666 6276), which is LOCKED (error 131031 again).
Never select that account. The other test account, 4544301289173934, is untried.

Twilio adapter built + deployed 2026-10-20 (POST /twilio, 19 tests pass, unsigned requests get 403).
Waiting on the user: a 2nd Twilio account (the 1st runs the price-compare bot), then put
TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN in .dev.vars, `npx wrangler deploy --secrets-file .dev.vars`,
set the sandbox "When a message comes in" to https://lamsa-bot.lamsa-bot.workers.dev/twilio (POST),
join the sandbox from the phone, and test.

## Earlier (2026-10-19)

Rewritten from Python/FastAPI to a Cloudflare Worker in TypeScript (hosting decision 2026-10-19: free
Worker instead of Railway Hobby $5/mo). The Python version is in git history (commit d23bda9).

Verified 2026-10-19: 16 offline tests pass, typecheck clean, and `wrangler dev` against the real Neon DB and
Gemini ran a full Arabic booking (Moroccan bath, "tomorrow 5pm" → 2026-10-20 17:00) that showed on the
admin page. Test rows were deleted afterwards.

Done earlier: GitHub repo `Abdullah13111/lamsa-bot`. Gemini: reuses the Dubai Agent Network key (shared free quota).

LIVE 2026-10-19 at https://lamsa-bot.lamsa-bot.workers.dev (Cloudflare account abdu.saleh92@hotmail.com).
Secrets GEMINI_API_KEY, ADMIN_TOKEN, WA_VERIFY_TOKEN uploaded with `npx wrangler deploy --secrets-file .dev.vars`.
Live check passed: health, EN + AR chat, CORS for the site, admin 401/200.
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
- Workers free plan: 100k requests/day, 10 ms CPU per request (waiting on Gemini/D1 does not count).
- WhatsApp retries are de-duplicated in the `wa_seen` table (a worker keeps no memory between requests).
- Testing Arabic with curl from Git Bash mangles it to `????`; use a Node script instead.
