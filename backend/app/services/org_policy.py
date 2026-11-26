"""Per-organisation access rules (SaaS phase 2), applied once the request is
bound to its organisation:

- ip_allowlist: addresses or ranges allowed to reach the organisation (empty =
  all). Applies to the web app, API, access keys, WebSockets, RDP, SSH proxy and
  application keys. Platform admins are not bound by it (support access): each
  such entry is audited.
- rate_limit_requests per rate_limit_window_seconds: requests per person in
  the organisation (Redis fixed window, shared by every backend process). The
  per-IP limit of the middleware stays as the platform's own protection.
"""

import ipaddress
import logging
import time

import redis.asyncio as aioredis
from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings

logger = logging.getLogger("citadel.org_policy")
RL_PREFIX = "citadel:rl:"
_redis: aioredis.Redis | None = None


def _r() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.REDIS_URL)
    return _redis


def parse_allowlist(values) -> list:
    nets = []
    for v in values or []:
        try:
            nets.append(ipaddress.ip_network(str(v).strip(), strict=False))
        except ValueError:
            logger.warning("ignored invalid ip_allowlist entry %r", v)
    return nets


def ip_allowed(ip: str | None, nets: list) -> bool:
    if not nets:
        return True
    if not ip:
        return False   # unknown source: fail closed
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if addr.version == 6 and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return any(addr in n for n in nets)


async def check_ip(db: AsyncSession, user, ip: str | None) -> None:
    """Organisation in context. Raises 403 when the address is not allowed."""
    from app.services.settings_service import get_setting_json
    nets = parse_allowlist(await get_setting_json(db, "ip_allowlist"))
    if ip_allowed(ip, nets):
        return
    if getattr(user, "is_platform_admin", False):
        from app.models.audit import AuditLog
        db.add(AuditLog(user_id=user.id, action="ip_allowlist.bypass", ip_address=ip,
                        result="administrateur de la plateforme hors de la liste d'adresses autorisées"))
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                        detail="Adresse IP non autorisée par cette organisation")


async def check_rate(db: AsyncSession, org_id, user_id) -> None:
    from app.services.settings_service import get_setting_int
    limit = await get_setting_int(db, "rate_limit_requests")
    window = max(1, await get_setting_int(db, "rate_limit_window_seconds"))
    if limit <= 0:
        return
    key = f"{RL_PREFIX}{org_id}:{user_id}:{int(time.time()) // window}"
    try:
        n = await _r().incr(key)
        if n == 1:
            await _r().expire(key, window + 5)
    except Exception:  # noqa: BLE001 - Redis down: do not lock everyone out
        logger.warning("rate limit check skipped (redis)")
        return
    if n > limit:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail="Trop de requêtes pour cette organisation, réessayez dans un instant",
                            headers={"Retry-After": str(window)})
