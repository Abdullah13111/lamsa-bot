"""HTTP entry points: web chat, WhatsApp webhook, bookings admin page."""
import html
import json
import logging
import secrets
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from threading import Lock

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, PlainTextResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel, Field

from . import agent, config, whatsapp
from .clients import get_client
from .store import get_store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("lamsa-bot")

@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    # Close Postgres connections on shutdown so redeploys don't hang on them.
    store = get_store()
    if hasattr(store, "pool"):
        store.pool.close()


app = FastAPI(title="Lamsa bot", docs_url=None, redoc_url=None, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_methods=["POST"],
    allow_headers=["Content-Type"],
)


class RateLimiter:
    """Sliding window per key. Protects the free Gemini quota from one noisy visitor."""

    def __init__(self, limit: int, window_s: int):
        self.limit, self.window_s = limit, window_s
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] > self.window_s:
                hits.popleft()
            if len(hits) >= self.limit:
                return False
            hits.append(now)
            return True


web_limiter = RateLimiter(limit=30, window_s=600)
# Ceiling for all web visitors together, in case per-IP limits are dodged.
web_total_limiter = RateLimiter(limit=300, window_s=3600)
seen_wa_ids = whatsapp.SeenIds()


def client_ip(request: Request) -> str:
    # Railway's proxy sets X-Real-IP. The last X-Forwarded-For entry is the one
    # our proxy added; earlier entries can be forged by the visitor.
    real_ip = request.headers.get("x-real-ip", "").strip()
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[-1].strip()
    return real_ip or forwarded or (request.client.host if request.client else "?")


@app.get("/health")
def health():
    return {"ok": True, "store": get_store().kind}


class ChatIn(BaseModel):
    client_id: str = Field(max_length=40)
    message: str = Field(min_length=1, max_length=1000)
    session_id: str = Field(min_length=1, max_length=100)


@app.post("/chat")
def chat(body: ChatIn, request: Request):
    client = get_client(body.client_id)
    if not client:
        raise HTTPException(404, "Unknown client")
    if not web_limiter.allow(client_ip(request)) or not web_total_limiter.allow("all"):
        raise HTTPException(429, "Too many messages, please try again in a few minutes")
    reply = agent.handle_message(client, f"web:{body.session_id}", "web", body.message.strip())
    return {"reply": reply}


@app.get("/webhook")
def verify_webhook(
    mode: str = Query("", alias="hub.mode"),
    token: str = Query("", alias="hub.verify_token"),
    challenge: str = Query("", alias="hub.challenge"),
):
    """Meta calls this once when you save the webhook URL in the app dashboard."""
    if mode == "subscribe" and config.WA_VERIFY_TOKEN and secrets.compare_digest(token, config.WA_VERIFY_TOKEN):
        return PlainTextResponse(challenge)
    raise HTTPException(403, "Verification failed")


@app.post("/webhook")
async def receive_webhook(request: Request, background: BackgroundTasks):
    raw = await request.body()
    if not whatsapp.verify_signature(raw, request.headers.get("x-hub-signature-256"), config.WA_APP_SECRET):
        log.warning("Rejected webhook with a bad or missing signature")
        raise HTTPException(403, "Bad signature")
    for msg in whatsapp.parse(json.loads(raw)):
        if msg.message_id and seen_wa_ids.check_and_add(msg.message_id):
            continue
        # Answer Meta at once; a slow reply would make it retry the webhook.
        background.add_task(handle_whatsapp, msg)
    return {"ok": True}


UNSUPPORTED_REPLY = (
    "أقدر أقرأ الرسائل النصية بس حالياً، اكتبي لي سؤالك لو سمحتي.\n"
    "I can only read text messages for now. Please type your question."
)


def handle_whatsapp(msg: whatsapp.Incoming) -> None:
    try:
        client = get_client(config.WA_CLIENT_ID)
        if not client:
            log.error("WA_CLIENT_ID %r has no clients/<id>.md file", config.WA_CLIENT_ID)
            return
        if msg.type != "text" or not msg.text:
            reply = UNSUPPORTED_REPLY
        else:
            reply = agent.handle_message(
                client, f"wa:{msg.sender}", "whatsapp", msg.text[:1000], phone=f"+{msg.sender}"
            )
        whatsapp.send_text(msg.phone_number_id, msg.sender, reply)
    except Exception:
        log.exception("Failed to handle WhatsApp message %s", msg.message_id)


basic = HTTPBasic(auto_error=False)


def require_admin(credentials: HTTPBasicCredentials | None = Depends(basic)) -> None:
    if not config.ADMIN_TOKEN:
        raise HTTPException(404)
    if not credentials or not secrets.compare_digest(credentials.password, config.ADMIN_TOKEN):
        raise HTTPException(401, headers={"WWW-Authenticate": "Basic"})


@app.get("/admin/bookings", response_class=HTMLResponse, dependencies=[Depends(require_admin)])
def admin_bookings(client_id: str = "lamsa"):
    client = get_client(client_id)
    if not client:
        raise HTTPException(404, "Unknown client")
    rows = get_store().list_bookings(client.id)
    cols = ["created_at", "channel", "name", "phone", "service", "date", "time", "stylist", "notes", "status"]

    def cell(row, col):
        value = row.get(col)
        if col == "created_at" and value:
            value = value.astimezone(agent.UAE_TZ).strftime("%Y-%m-%d %H:%M")
        return f"<td>{html.escape(str(value or ''))}</td>"

    body_rows = "".join("<tr>" + "".join(cell(r, c) for c in cols) + "</tr>" for r in rows)
    empty = '<p>No booking requests yet.</p>' if not rows else ""
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bookings · {html.escape(client.name)}</title>
<style>
body{{font-family:system-ui,sans-serif;margin:16px;color:#2B2326;background:#FBF7F4}}
table{{border-collapse:collapse;width:100%;font-size:14px;background:#fff}}
th,td{{border:1px solid #e6dcd6;padding:6px 8px;text-align:start;vertical-align:top}}
th{{background:#7A4E5A;color:#fff}} .wrap{{overflow-x:auto}}
</style></head><body>
<h1>{html.escape(client.name)}: booking requests ({len(rows)})</h1>{empty}
<div class="wrap"><table><thead><tr>{"".join(f"<th>{c}</th>" for c in cols)}</tr></thead>
<tbody>{body_rows}</tbody></table></div></body></html>"""
