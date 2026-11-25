"""Citadel sessions (SaaS phase 3).

After a sign-in at a provider, the person gets:
- a refresh cookie (HttpOnly, path /api/auth), rotated on every use; reusing
  a rotated cookie revokes the session (stolen cookie), except within a few
  seconds (two tabs refreshing at once);
- short access tokens (JWT HS256, 10 minutes) signed with a platform key kept
  encrypted in app_settings, carrying the session id and the time of the last
  interactive sign-in (auth_time, for the re-authentication before terminals).
Every access token is checked against its session (revocation is immediate).
"""

import base64
import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from jose import jwt
from jose.exceptions import JOSEError
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import tenancy
from app.core.config import settings
from app.models.auth import AuthSession

ACCESS_MINUTES = 10
REUSE_GRACE_SECONDS = 20
SIGNING_SETTING = "_session_signing_key"
ISSUER = "citadel"
COOKIE = "citadel_refresh"

ROTATED_PREFIX = "citadel:session:rotated:"

_signing_key: str | None = None
_redis_client = None


def _redis():
    global _redis_client
    if _redis_client is None:
        import redis.asyncio as aioredis
        _redis_client = aioredis.from_url(settings.REDIS_URL)
    return _redis_client


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def signing_key(db: AsyncSession) -> str:
    """Platform key (org_id NULL), generated once, encrypted with the default key."""
    global _signing_key
    if _signing_key:
        return _signing_key
    from app.core.security import decrypt_value, encrypt_value
    from app.models.settings import AppSetting
    async with tenancy.system_in(db):
        row = (await db.execute(select(AppSetting).where(AppSetting.key == SIGNING_SETTING,
                                                         AppSetting.org_id.is_(None)))).scalar_one_or_none()
        if row is None:
            key = base64.b64encode(secrets.token_bytes(64)).decode()
            db.add(AppSetting(key=SIGNING_SETTING, value=base64.b64encode(encrypt_value(key)).decode(),
                              description="Clé de signature des sessions (chiffrée)"))
            await db.commit()
        else:
            key = decrypt_value(base64.b64decode(row.value))
    _signing_key = key
    return key


async def create(db: AsyncSession, user_id, provider_id, ip: str | None, user_agent: str | None) -> tuple[AuthSession, str]:
    refresh = secrets.token_urlsafe(48)
    now = _now()
    s = AuthSession(user_id=user_id, provider_id=provider_id, refresh_hash=_hash(refresh), auth_time=now,
                    last_used_at=now, expires_at=now + timedelta(hours=settings.SESSION_HOURS),
                    ip_address=ip, user_agent=(user_agent or "")[:500] or None)
    db.add(s)
    await db.flush()
    return s, refresh


async def access_token(db: AsyncSession, s: AuthSession) -> tuple[str, int]:
    now = _now()
    claims = {"iss": ISSUER, "typ": "access", "sub": str(s.user_id), "sid": str(s.id),
              "iat": int(now.timestamp()), "exp": int((now + timedelta(minutes=ACCESS_MINUTES)).timestamp()),
              "auth_time": int(s.auth_time.timestamp())}
    return jwt.encode(claims, await signing_key(db), algorithm="HS256"), ACCESS_MINUTES * 60


class SessionError(Exception):
    pass


async def refresh(db: AsyncSession, token: str) -> tuple[AuthSession, str | None]:
    """(session, new refresh token). New token None = concurrent refresh within
    the grace period (the browser already holds the newer cookie)."""
    if not token:
        raise SessionError("no session")
    h = _hash(token)
    now = _now()
    s = (await db.execute(select(AuthSession).where(AuthSession.refresh_hash == h))).scalar_one_or_none()
    if s is None:
        old = (await db.execute(select(AuthSession).where(AuthSession.previous_hash == h))).scalar_one_or_none()
        if old is None:
            # an older cookie of the chain: revoke its session (stolen)
            sid = await _redis().get(ROTATED_PREFIX + h)
            if sid:
                old = await db.get(AuthSession, uuid.UUID(sid.decode()))
                if old is not None and old.revoked_at is None:
                    old.revoked_at = now
                    await db.commit()
            raise SessionError("unknown session")
        if old.revoked_at is None and old.last_used_at and (now - old.last_used_at).total_seconds() <= REUSE_GRACE_SECONDS \
                and old.expires_at > now:
            return old, None
        old.revoked_at = old.revoked_at or now   # a rotated cookie came back: stolen
        await db.commit()
        raise SessionError("refresh token reused")
    if s.revoked_at is not None or s.expires_at <= now:
        raise SessionError("session ended")
    new = secrets.token_urlsafe(48)
    if s.previous_hash:   # every rotated cookie stays known until the session would have ended
        ttl = max(60, int((s.expires_at - now).total_seconds()))
        await _redis().set(ROTATED_PREFIX + s.previous_hash, str(s.id), ex=ttl)
    s.previous_hash, s.refresh_hash, s.last_used_at = h, _hash(new), now
    await db.flush()
    return s, new


async def verify(db: AsyncSession, token: str) -> tuple[AuthSession, dict]:
    """Access token -> (live session, claims)."""
    try:
        header = jwt.get_unverified_header(token)
        if header.get("alg") != "HS256":
            raise SessionError("bad algorithm")
        claims = jwt.decode(token, await signing_key(db), algorithms=["HS256"], issuer=ISSUER,
                            options={"verify_aud": False})
    except JOSEError as e:
        raise SessionError("invalid token") from e
    if claims.get("typ") != "access":
        raise SessionError("not an access token")
    s = await db.get(AuthSession, uuid.UUID(claims["sid"]))
    if s is None or s.revoked_at is not None or s.expires_at <= _now() or str(s.user_id) != claims.get("sub"):
        raise SessionError("session ended")
    return s, claims


async def revoke(db: AsyncSession, s: AuthSession) -> None:
    s.revoked_at = s.revoked_at or _now()


async def revoke_all(db: AsyncSession, user_id) -> None:
    await db.execute(update(AuthSession).where(AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None))
                     .values(revoked_at=_now()))


def cookie_kwargs() -> dict:
    secure = settings.PUBLIC_URL.startswith("https://")
    return {"key": COOKIE, "httponly": True, "secure": secure, "samesite": "lax", "path": "/api/auth",
            "max_age": settings.SESSION_HOURS * 3600}
