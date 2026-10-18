"""Offline tests: Gemini and the WhatsApp send API are replaced with fakes."""
import hashlib
import hmac
import json
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app import agent, config, llm, main, whatsapp
from app.clients import get_client
from app.store import MemoryStore, get_store

BOOKING = {
    "name": "Mariam",
    "phone": "0501234567",
    "service": "Keratin treatment",
    "date": "2026-10-20",
    "time": "16:00",
    "stylist": "Rania",
    "notes": None,
}


@pytest.fixture(autouse=True)
def fresh_state(monkeypatch):
    get_store.cache_clear()
    monkeypatch.setattr(config, "DATABASE_URL", "")
    monkeypatch.setattr(main, "web_limiter", main.RateLimiter(limit=30, window_s=600))
    monkeypatch.setattr(main, "seen_wa_ids", whatsapp.SeenIds())
    yield
    get_store.cache_clear()


@pytest.fixture
def fake_llm(monkeypatch):
    calls = []
    answers = []

    def generate(system, contents):
        calls.append({"system": system, "contents": contents})
        return answers.pop(0) if answers else {"reply": "Hello!", "booking": None}

    monkeypatch.setattr(llm, "generate", generate)
    return calls, answers


@pytest.fixture
def http():
    return TestClient(main.app)


def test_lamsa_client_loads():
    client = get_client("lamsa")
    assert client.name.startswith("Lamsa Beauty Lounge")
    assert "Keratin treatment" in client.knowledge
    assert get_client("../secrets") is None
    assert get_client("nobody") is None


def test_chat_replies_and_keeps_history(http, fake_llm):
    calls, answers = fake_llm
    answers += [{"reply": "Hi! How can I help?", "booking": None}, {"reply": "From AED 600.", "booking": None}]
    payload = {"client_id": "lamsa", "message": "hello", "session_id": "abc123"}
    assert http.post("/chat", json=payload).json() == {"reply": "Hi! How can I help?"}
    payload["message"] = "keratin price?"
    assert http.post("/chat", json=payload).json() == {"reply": "From AED 600."}
    roles = [c["role"] for c in calls[1]["contents"]]
    assert roles == ["user", "model", "user"]
    assert "Ask for a UAE mobile number" in calls[1]["system"]


def test_chat_rejects_unknown_client_and_long_message(http, fake_llm):
    assert http.post("/chat", json={"client_id": "x", "message": "hi", "session_id": "s"}).status_code == 404
    long = {"client_id": "lamsa", "message": "a" * 1001, "session_id": "s"}
    assert http.post("/chat", json=long).status_code == 422


def test_chat_rate_limit(http, fake_llm, monkeypatch):
    monkeypatch.setattr(main, "web_limiter", main.RateLimiter(limit=2, window_s=600))
    payload = {"client_id": "lamsa", "message": "hi", "session_id": "s"}
    codes = [http.post("/chat", json=payload).status_code for _ in range(3)]
    assert codes == [200, 200, 429]


def test_booking_saved_once(fake_llm):
    _, answers = fake_llm
    answers += [
        {"reply": "Booked, the team will confirm.", "booking": dict(BOOKING)},
        {"reply": "You're welcome!", "booking": dict(BOOKING)},  # model repeats it
    ]
    client = get_client("lamsa")
    agent.handle_message(client, "web:s1", "web", "yes confirm")
    agent.handle_message(client, "web:s1", "web", "thanks")
    rows = get_store().list_bookings("lamsa")
    assert len(rows) == 1
    assert rows[0]["service"] == "Keratin treatment"


def test_llm_failure_gives_fallback(monkeypatch):
    def broken(system, contents):
        raise llm.LLMError("quota")

    monkeypatch.setattr(llm, "generate", broken)
    reply = agent.handle_message(get_client("lamsa"), "web:s2", "web", "hi")
    assert reply == agent.FALLBACK_REPLY["web"]


def test_system_prompt_has_date_and_whatsapp_phone():
    now = datetime(2026, 10, 18, 19, 30, tzinfo=agent.UAE_TZ)
    prompt = agent.system_prompt(get_client("lamsa"), "whatsapp", "+971501234567", now)
    assert "Sunday 18 October 2026, 19:30" in prompt
    assert "+971501234567" in prompt and "do not ask for it" in prompt


def test_llm_clean_drops_incomplete_booking():
    out = llm._clean({"reply": " hi ", "booking": {"name": "A", "phone": "", "service": "x", "date": "d", "time": "t"}})
    assert out == {"reply": "hi", "booking": None}


def test_webhook_verification(http, monkeypatch):
    monkeypatch.setattr(config, "WA_VERIFY_TOKEN", "secret-token")
    ok = http.get("/webhook", params={"hub.mode": "subscribe", "hub.verify_token": "secret-token", "hub.challenge": "42"})
    assert ok.status_code == 200 and ok.text == "42"
    bad = http.get("/webhook", params={"hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "42"})
    assert bad.status_code == 403


def _wa_payload(message_id="wamid.1", text="مرحبا لمسة، أبي أحجز موعد"):
    return {
        "object": "whatsapp_business_account",
        "entry": [{"changes": [{"field": "messages", "value": {
            "metadata": {"phone_number_id": "PNID"},
            "contacts": [{"wa_id": "971501234567", "profile": {"name": "Mariam"}}],
            "messages": [{"id": message_id, "from": "971501234567", "type": "text", "text": {"body": text}}],
        }}]}],
    }


def _signed_post(http, payload, secret="app-secret"):
    raw = json.dumps(payload).encode()
    sig = "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return http.post("/webhook", content=raw, headers={"X-Hub-Signature-256": sig, "Content-Type": "application/json"})


def test_webhook_replies_once_per_message(http, fake_llm, monkeypatch):
    calls, answers = fake_llm
    answers.append({"reply": "أهلاً! أي خدمة تبين؟", "booking": None})
    monkeypatch.setattr(config, "WA_APP_SECRET", "app-secret")
    sent = []
    monkeypatch.setattr(whatsapp, "send_text", lambda pnid, to, body: sent.append((pnid, to, body)))

    assert _signed_post(http, _wa_payload()).status_code == 200
    assert _signed_post(http, _wa_payload()).status_code == 200  # Meta retry
    assert sent == [("PNID", "971501234567", "أهلاً! أي خدمة تبين؟")]
    assert "+971501234567" in calls[0]["system"]


def test_webhook_rejects_bad_signature(http, monkeypatch):
    monkeypatch.setattr(config, "WA_APP_SECRET", "app-secret")
    assert _signed_post(http, _wa_payload(), secret="wrong").status_code == 403
    monkeypatch.setattr(config, "WA_APP_SECRET", "")
    assert _signed_post(http, _wa_payload(), secret="").status_code == 403


def test_webhook_ignores_status_updates(http, monkeypatch):
    monkeypatch.setattr(config, "WA_APP_SECRET", "app-secret")
    sent = []
    monkeypatch.setattr(whatsapp, "send_text", lambda *a: sent.append(a))
    status_only = {"entry": [{"changes": [{"value": {"metadata": {"phone_number_id": "PNID"},
                                                    "statuses": [{"id": "wamid.9", "status": "read"}]}}]}]}
    assert _signed_post(http, status_only).status_code == 200
    assert sent == []


def test_admin_page(http, fake_llm, monkeypatch):
    _, answers = fake_llm
    answers.append({"reply": "Done", "booking": dict(BOOKING)})
    agent.handle_message(get_client("lamsa"), "web:s3", "web", "confirm")
    monkeypatch.setattr(config, "ADMIN_TOKEN", "")
    assert http.get("/admin/bookings").status_code == 404
    monkeypatch.setattr(config, "ADMIN_TOKEN", "pw")
    assert http.get("/admin/bookings").status_code == 401
    page = http.get("/admin/bookings", auth=("admin", "pw"))
    assert page.status_code == 200 and "Mariam" in page.text and "Keratin treatment" in page.text


def test_memory_store_is_default():
    assert isinstance(get_store(), MemoryStore)


def test_reply_language_follows_latest_message(fake_llm):
    calls, _ = fake_llm
    client = get_client("lamsa")
    agent.handle_message(client, "web:lang", "web", "كم سعر الحمام المغربي؟")
    agent.handle_message(client, "web:lang", "web", "bridal quote please")
    agent.handle_message(client, "web:lang", "web", "050 123 4567")
    assert "Reply in Arabic only" in calls[0]["system"]
    assert "Reply in English only" in calls[1]["system"]
    assert "latest message is in" not in calls[2]["system"]
