"""Gemini call that returns the bot's reply plus an optional booking, as JSON.

One request per customer message: structured output (responseSchema) instead
of function calling, which would need a second round trip.
"""
import json
import logging

import httpx

from . import config

log = logging.getLogger(__name__)

# The free tier allows only ~20 gemini-2.5-flash requests a day; the lite
# models allow far more. On a quota 429 (or a 404 when Google retires a model
# name) we step down the chain instead of failing the customer. Same chain as
# the price-compare bot.
FALLBACK_MODELS = ["gemini-flash-lite-latest", "gemini-3.1-flash-lite"]

_BOOKING_FIELDS = ["name", "phone", "service", "date", "time"]

RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "reply": {"type": "STRING"},
        "booking": {
            "type": "OBJECT",
            "nullable": True,
            "properties": {
                "name": {"type": "STRING"},
                "phone": {"type": "STRING"},
                "service": {"type": "STRING"},
                "date": {"type": "STRING", "description": "YYYY-MM-DD"},
                "time": {"type": "STRING", "description": "HH:MM, 24-hour"},
                "stylist": {"type": "STRING", "nullable": True},
                "notes": {"type": "STRING", "nullable": True},
            },
            "required": _BOOKING_FIELDS,
        },
    },
    "required": ["reply"],
}


class LLMError(Exception):
    pass


def generate(system: str, contents: list[dict]) -> dict:
    """Return {"reply": str, "booking": dict | None}. Raises LLMError."""
    if not config.GEMINI_API_KEY:
        raise LLMError("GEMINI_API_KEY is not set")
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": contents,
        "generationConfig": {
            "temperature": 0.4,
            "responseMimeType": "application/json",
            "responseSchema": RESPONSE_SCHEMA,
        },
    }
    models = [config.GEMINI_MODEL] + [m for m in FALLBACK_MODELS if m != config.GEMINI_MODEL]
    last_err = ""
    for model in models:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        try:
            r = httpx.post(
                url,
                headers={"x-goog-api-key": config.GEMINI_API_KEY},
                json=body,
                timeout=15,
            )
        except httpx.HTTPError as e:
            last_err = f"{model}: {e!r}"
            continue
        if r.status_code in (404, 429) or r.status_code >= 500:
            last_err = f"{model} HTTP {r.status_code}"
            log.warning("Gemini %s, trying next model", last_err)
            continue
        if r.status_code != 200:
            raise LLMError(f"{model} HTTP {r.status_code}: {r.text[:300]}")
        try:
            parts = r.json()["candidates"][0]["content"]["parts"]
            data = json.loads("".join(p.get("text", "") for p in parts))
        except (KeyError, IndexError, ValueError) as e:
            last_err = f"{model} bad response: {e!r}"
            continue
        return _clean(data)
    raise LLMError(last_err or "no model answered")


def _clean(data: dict) -> dict:
    reply = str(data.get("reply") or "").strip()
    booking = data.get("booking")
    if not isinstance(booking, dict) or not all(str(booking.get(f) or "").strip() for f in _BOOKING_FIELDS):
        booking = None
    return {"reply": reply, "booking": booking}
