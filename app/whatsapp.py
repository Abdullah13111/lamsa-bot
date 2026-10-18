"""WhatsApp Cloud API (Meta): webhook parsing, signature check, sending replies."""
import hashlib
import hmac
import logging
from collections import OrderedDict
from dataclasses import dataclass
from threading import Lock

import httpx

from . import config

log = logging.getLogger(__name__)


@dataclass
class Incoming:
    message_id: str
    phone_number_id: str
    sender: str  # wa_id: international number, digits only
    type: str
    text: str


def verify_signature(body: bytes, header: str | None, secret: str) -> bool:
    """Meta signs every webhook POST with the app secret (X-Hub-Signature-256)."""
    if not secret or not header:
        return False
    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header)


def parse(payload: dict) -> list[Incoming]:
    """Customer messages in a webhook payload. Delivery/read statuses are skipped."""
    out = []
    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value", {})
            phone_number_id = value.get("metadata", {}).get("phone_number_id", "")
            for m in value.get("messages", []):
                text = m.get("text", {}).get("body", "") if m.get("type") == "text" else ""
                out.append(
                    Incoming(
                        message_id=m.get("id", ""),
                        phone_number_id=phone_number_id,
                        sender=m.get("from", ""),
                        type=m.get("type", ""),
                        text=text.strip(),
                    )
                )
    return out


class SeenIds:
    """Meta retries webhooks it thinks failed; remember recent message ids."""

    def __init__(self, size: int = 1000):
        self._ids: OrderedDict[str, None] = OrderedDict()
        self._size = size
        self._lock = Lock()

    def check_and_add(self, message_id: str) -> bool:
        """True if this id was already seen."""
        with self._lock:
            if message_id in self._ids:
                return True
            self._ids[message_id] = None
            if len(self._ids) > self._size:
                self._ids.popitem(last=False)
            return False


def send_text(phone_number_id: str, to: str, body: str) -> None:
    url = f"https://graph.facebook.com/{config.WA_GRAPH_VERSION}/{phone_number_id}/messages"
    r = httpx.post(
        url,
        headers={"Authorization": f"Bearer {config.WA_ACCESS_TOKEN}"},
        json={
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            "type": "text",
            "text": {"preview_url": False, "body": body[:4096]},
        },
        timeout=15,
    )
    if r.status_code >= 400:
        log.error("WhatsApp send failed: HTTP %s %s", r.status_code, r.text[:500])
