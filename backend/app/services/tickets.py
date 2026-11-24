"""One-time connection tickets (Redis, short TTL).

Used by the RDP WebSocket so that neither the bearer token nor an @INPUT
password ever appears in a URL (uvicorn logs WebSocket query strings).
The account is resolved and authorized when the ticket is issued; the
ticket only carries already-encrypted secrets.
"""

import base64
import json
import secrets
import uuid

import redis.asyncio as aioredis

from app.core.config import settings
from app.core.permissions import ResolvedAccount

TICKET_TTL_SECONDS = 60
_PREFIX = "citadel:ticket:"
_client: aioredis.Redis | None = None


def _redis() -> aioredis.Redis:
    global _client
    if _client is None:
        _client = aioredis.from_url(settings.REDIS_URL)
    return _client


def _b64(v: bytes | None) -> str | None:
    return base64.b64encode(v).decode() if v is not None else None


def _unb64(v: str | None) -> bytes | None:
    return base64.b64decode(v) if v is not None else None


async def issue_ticket(
    user_id: uuid.UUID, server_id: uuid.UUID, protocol: str,
    account: ResolvedAccount, extra: dict | None = None,
) -> str:
    ticket = secrets.token_urlsafe(32)
    payload = {
        "user_id": str(user_id),
        "server_id": str(server_id),
        "protocol": protocol,
        "account": {
            "username": account.username,
            "password": _b64(account.password),
            "ssh_key": _b64(account.ssh_key),
            "use_cert": account.use_cert,
            "cert_minutes": account.cert_minutes,
            "label": account.label,
            "account_id": str(account.account_id) if account.account_id else None,
        },
        "extra": extra or {},
    }
    await _redis().set(_PREFIX + ticket, json.dumps(payload), ex=TICKET_TTL_SECONDS)
    return ticket


async def consume_ticket(ticket: str) -> tuple[dict, ResolvedAccount] | None:
    """Return (payload, account) once; the ticket is deleted atomically."""
    if not ticket:
        return None
    raw = await _redis().getdel(_PREFIX + ticket)
    if raw is None:
        return None
    payload = json.loads(raw)
    if payload.get("raw") or "account" not in payload:
        return None  # a monitoring ticket can never open a session
    a = payload["account"]
    account = ResolvedAccount(
        username=a["username"],
        password=_unb64(a["password"]),
        ssh_key=_unb64(a["ssh_key"]),
        use_cert=a["use_cert"],
        cert_minutes=a["cert_minutes"],
        label=a["label"],
        account_id=uuid.UUID(a["account_id"]) if a["account_id"] else None,
    )
    return payload, account


async def issue_raw(payload: dict) -> str:
    """Ticket carrying an arbitrary payload (e.g. RDP monitoring), same TTL and one-shot use."""
    ticket = secrets.token_urlsafe(32)
    await _redis().set(_PREFIX + ticket, json.dumps({"raw": True, **payload}), ex=TICKET_TTL_SECONDS)
    return ticket


async def consume_raw(ticket: str) -> dict | None:
    if not ticket:
        return None
    raw = await _redis().getdel(_PREFIX + ticket)
    if raw is None:
        return None
    payload = json.loads(raw)
    return payload if payload.get("raw") else None
