"""Settings, read once from the environment (and a local .env file when present)."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader for local runs; real env vars always win."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv(ROOT / ".env")


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


GEMINI_API_KEY = _env("GEMINI_API_KEY")
GEMINI_MODEL = _env("GEMINI_MODEL", "gemini-2.5-flash")

# Empty = in-memory storage (local dev and tests). Set a Neon URL in production.
DATABASE_URL = _env("DATABASE_URL")

# WhatsApp Cloud API (Meta). One WhatsApp number per deployment for now,
# answering as WA_CLIENT_ID.
WA_VERIFY_TOKEN = _env("WA_VERIFY_TOKEN")
WA_APP_SECRET = _env("WA_APP_SECRET")
WA_ACCESS_TOKEN = _env("WA_ACCESS_TOKEN")
WA_GRAPH_VERSION = _env("WA_GRAPH_VERSION", "v23.0")
WA_CLIENT_ID = _env("WA_CLIENT_ID", "lamsa")

CORS_ORIGINS = [
    o.strip()
    for o in _env(
        "CORS_ORIGINS",
        "https://lamsa-website-theta.vercel.app,http://localhost:4321",
    ).split(",")
    if o.strip()
]

# Password for /admin/bookings (any username). Empty = admin page disabled.
ADMIN_TOKEN = _env("ADMIN_TOKEN")
