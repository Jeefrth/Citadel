"""Citadel sign-ins and devices (lot 6).

Every authenticated API call is tied to a device: the browser sends a random
id (X-Citadel-Device, kept in localStorage), an access key is its own device.
A device's first call, or its first call after LOGIN_IDLE_HOURS of silence,
is a sign-in (LoginEvent). Redis keeps the hot path to one GET per minute.

Revoking a browser device makes the API answer 401 "device_revoked" and the
front signs out. The Entra session itself stays valid: to cut someone off,
deactivate the Citadel user (immediate) or revoke the Entra sessions.
Revoking an access key device also deactivates the key.
"""

import logging
import re
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.identity import LoginEvent, UserDevice
from app.models.user import User
from app.services import live

logger = logging.getLogger("citadel.devices")
DEVICE_HEADER = "x-citadel-device"
DEVICE_ID = re.compile(r"^[A-Za-z0-9-]{8,64}$")
LOGIN_IDLE_HOURS = 8
CACHE_SECONDS = 60
REVOKED_DETAIL = "device_revoked"


def _cache_key(user_id, device_key: str) -> str:
    return f"citadel:dev:{user_id}:{device_key}"


def device_label(ua: str | None) -> str:
    ua = ua or ""
    browser = next((name for token, name in (
        ("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"), ("Chrome/", "Chrome"),
        ("Safari/", "Safari"), ("curl/", "curl"), ("python", "Python"), ("PowerShell", "PowerShell"),
    ) if token in ua), "Client inconnu")
    system = next((name for token, name in (
        ("Windows", "Windows"), ("Mac OS X", "macOS"), ("Macintosh", "macOS"), ("iPhone", "iOS"),
        ("iPad", "iPadOS"), ("Android", "Android"), ("Linux", "Linux"),
    ) if token in ua), "")
    return f"{browser} · {system}" if system else browser


def device_key_for(request: Request, access_key_prefix: str | None) -> tuple[str, str]:
    if access_key_prefix:
        return f"key:{access_key_prefix}", "access_key"
    raw = request.headers.get(DEVICE_HEADER, "")
    return (f"web:{raw}" if DEVICE_ID.match(raw) else "web:unknown"), "web"


async def _cache_get(key: str) -> str | None:
    try:
        v = await live.redis().get(key)
        return v.decode() if isinstance(v, bytes) else v
    except Exception:  # noqa: BLE001 - Redis down: fall back to the database
        return None


async def _cache_set(key: str, value: str) -> None:
    try:
        await live.redis().set(key, value, ex=CACHE_SECONDS)
    except Exception:  # noqa: BLE001
        pass


async def _cache_drop(key: str) -> None:
    try:
        await live.redis().delete(key)
    except Exception:  # noqa: BLE001
        pass


async def touch(db: AsyncSession, user: User, request: Request, ip: str | None,
                access_key_prefix: str | None = None) -> None:
    device_key, kind = device_key_for(request, access_key_prefix)
    ck = _cache_key(user.id, device_key)
    cached = await _cache_get(ck)
    if cached == "revoked":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=REVOKED_DETAIL)
    if cached:
        return
    now = datetime.now(timezone.utc)
    ua = (request.headers.get("user-agent") or "")[:500]
    dev = (await db.execute(select(UserDevice).where(
        UserDevice.user_id == user.id, UserDevice.device_key == device_key))).scalar_one_or_none()
    if dev is not None and dev.revoked_at is not None:
        await _cache_set(ck, "revoked")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=REVOKED_DETAIL)
    new_login = dev is None or dev.last_seen < now - timedelta(hours=LOGIN_IDLE_HOURS)
    if dev is None:
        dev = UserDevice(user_id=user.id, device_key=device_key, kind=kind, label=device_label(ua),
                         user_agent=ua, ip_address=ip, first_seen=now, last_seen=now)
        db.add(dev)
        await db.flush()
    dev.last_seen, dev.ip_address = now, ip
    if ua:
        dev.user_agent, dev.label = ua, device_label(ua)
    if new_login:
        db.add(LoginEvent(user_id=user.id, user_name=user.display_name, device_id=dev.id,
                          method="access_key" if kind == "access_key" else "entra",
                          ip_address=ip, user_agent=ua))
    await db.commit()
    await _cache_set(ck, str(dev.id))


async def record_denied(db: AsyncSession, user: User | None, ip: str | None, reason: str,
                        method: str = "entra", user_agent: str | None = None) -> None:
    db.add(LoginEvent(user_id=user.id if user else None, user_name=user.display_name if user else "",
                      method=method, result="denied", reason=reason[:255], ip_address=ip,
                      user_agent=(user_agent or "")[:500] or None))


async def revoke(db: AsyncSession, dev: UserDevice, by: str) -> None:
    dev.revoked_at, dev.revoked_by = datetime.now(timezone.utc), by
    if dev.kind == "access_key":
        from app.models.pam import AccessKey
        prefix = dev.device_key.split(":", 1)[1]
        key = (await db.execute(select(AccessKey).where(AccessKey.prefix == prefix))).scalar_one_or_none()
        if key is not None:
            key.is_active = False
    await _cache_drop(_cache_key(dev.user_id, dev.device_key))
