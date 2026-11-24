"""Background jobs: due rotations, periodic verification and discovery.

One loop per backend process; a Redis lock makes sure only one process
runs a cycle at a time (safe with several uvicorn workers).
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

import redis.asyncio as aioredis
from sqlalchemy import or_, select

from app.core.config import settings
from app.core.database import async_session
from app.models.pam import Account
from app.models.server import Server
from app.services import secrets_ops

logger = logging.getLogger("citadel.scheduler")
LOCK_KEY = "citadel:scheduler:lock"
MAX_PER_CYCLE = 20  # keep cycles short; the rest is picked up next time


async def run_cycle() -> dict:
    now = datetime.now(timezone.utc)
    stats = {"rotated": 0, "rotation_failed": 0, "verified": 0, "discovered": 0}
    async with async_session() as db:
        # 1. Due rotations
        accounts = (await db.execute(
            select(Account).where(Account.is_active.is_(True), Account.rotation_enabled.is_(True))
        )).scalars().all()
        due = [a for a in accounts
               if a.last_rotated_at is None or a.last_rotated_at + timedelta(days=a.rotation_interval_days) <= now]
        for account in due[:MAX_PER_CYCLE]:
            res = await secrets_ops.rotate_account(db, account, reason="scheduled")
            stats["rotated" if res.ok else "rotation_failed"] += 1
            if not res.ok:
                logger.warning("scheduled rotation failed for %s: %s", account.username, res.message)

        # 2. Periodic verification
        threshold = now - timedelta(hours=settings.ACCOUNT_VERIFY_INTERVAL_HOURS)
        to_verify = (await db.execute(
            select(Account).where(
                Account.is_active.is_(True),
                or_(Account.last_verified_at.is_(None), Account.last_verified_at < threshold),
            ).limit(MAX_PER_CYCLE)
        )).scalars().all()
        for account in to_verify:
            await secrets_ops.verify_account(db, account)
            stats["verified"] += 1

        # 3. Periodic discovery
        threshold = now - timedelta(hours=settings.ACCOUNT_DISCOVERY_INTERVAL_HOURS)
        servers = (await db.execute(
            select(Server).where(or_(Server.accounts_discovered_at.is_(None), Server.accounts_discovered_at < threshold))
            .limit(MAX_PER_CYCLE)
        )).scalars().all()
        for server in servers:
            if server.default_account is None:
                continue
            res = await secrets_ops.discover_accounts(db, server)
            if res.ok:
                stats["discovered"] += 1
            else:
                # Don't retry a broken server every cycle
                server.accounts_discovered_at = now
                await db.commit()
    return stats


async def scheduler_loop(stop: asyncio.Event) -> None:
    client = aioredis.from_url(settings.REDIS_URL)
    interval = max(30, settings.SCHEDULER_INTERVAL_SECONDS)
    await asyncio.sleep(15)  # let the app finish starting
    while not stop.is_set():
        try:
            if await client.set(LOCK_KEY, "1", nx=True, ex=interval - 5):
                stats = await run_cycle()
                if any(stats.values()):
                    logger.info("scheduler cycle: %s", stats)
        except Exception:  # noqa: BLE001 - never kill the loop
            logger.exception("scheduler cycle failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass
    await client.aclose()
