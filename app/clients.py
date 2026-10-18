"""Salon clients. Each client is one Markdown file in clients/<id>.md."""
import re
from dataclasses import dataclass
from functools import lru_cache

from .config import ROOT

CLIENTS_DIR = ROOT / "clients"
_ID_RE = re.compile(r"^[a-z0-9-]{1,40}$")


@dataclass(frozen=True)
class Client:
    id: str
    name: str
    knowledge: str


@lru_cache
def get_client(client_id: str) -> Client | None:
    if not _ID_RE.match(client_id):
        return None
    path = CLIENTS_DIR / f"{client_id}.md"
    if not path.exists():
        return None
    knowledge = path.read_text(encoding="utf-8")
    first_line = knowledge.splitlines()[0] if knowledge else ""
    name = first_line.lstrip("# ").strip() or client_id
    return Client(id=client_id, name=name, knowledge=knowledge)
