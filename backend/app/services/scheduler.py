"""Background jobs: due rotations, periodic verification and discovery.

One loop per backend process; a Redis lock makes sure only one process
runs a cycle at a time (safe with several uvicorn workers).
"""

import asyncio
import logging
from zoneinfo import ZoneInfo
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
    stats = {"rotated": 0, "rotation_failed": 0, "verified": 0, "discovered": 0, "approvals_expired": 0}
    async with async_session() as db:
        # 0. Pending approvals past their deadline
        from app.services.approvals import expire_pending
        stats["approvals_expired"] = await expire_pending(db)

        # 0b. Retention of recordings and command journal (D8)
        stats.update(await apply_retention(db))

        # 0c. Cloud inventory sync (A8)
        from app.models.operations import CloudAccount
        from app.services.cloud_sync import sync_account
        clouds = (await db.execute(select(CloudAccount).where(CloudAccount.is_active.is_(True)))).scalars().all()
        stats["cloud_synced"] = 0
        for acc in clouds:
            if acc.last_sync_at is None or acc.last_sync_at + timedelta(minutes=acc.sync_interval_minutes) <= now:
                await sync_account(db, acc)
                stats["cloud_synced"] += 1

        # 0d. Access policies about to expire (lot 6)
        stats["expiry_reminders"] = await remind_expiring_policies(db, now)

        # 0e. Encrypted account backup (lot 7)
        from app.services.account_backup import scheduled as scheduled_backup
        stats["backups"] = await scheduled_backup(db, now)

        # 0f. Risk detection, once a day (lot 7)
        from app.services.risks import scheduled as scheduled_risks
        stats["risk_scans"] = await scheduled_risks(db, now)

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


async def apply_retention(db) -> dict:
    from sqlalchemy import delete

    from app.models.audit import AuditLog
    from app.models.audit_trail import CommandLog
    from app.models.session_recording import SessionRecording
    from app.services import recording_storage
    from app.services.settings_service import get_setting_int

    out = {"recordings_purged": 0, "commands_purged": 0}
    now = datetime.now(timezone.utc)
    days = await get_setting_int(db, "recording_retention_days")
    if days > 0:
        old = (await db.execute(select(SessionRecording).where(
            SessionRecording.ended_at.is_not(None), SessionRecording.started_at < now - timedelta(days=days)
        ).limit(200))).scalars().all()
        for rec in old:
            if rec.storage_key:
                await recording_storage.remove(db, rec.storage_type, rec.storage_key)
            await db.delete(rec)
        out["recordings_purged"] = len(old)
        if old:
            from app.services.secrets_ops import _system_user_id
            uid = await _system_user_id(db)
            if uid:
                db.add(AuditLog(user_id=uid, action="recording.retention",
                                result=f"{len(old)} recording(s) older than {days} days deleted"))
    days = await get_setting_int(db, "command_log_retention_days")
    if days > 0:
        res = await db.execute(delete(CommandLog).where(CommandLog.created_at < now - timedelta(days=days)))
        out["commands_purged"] = res.rowcount or 0
    await db.commit()
    return out


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


async def remind_expiring_policies(db, now: datetime) -> int:
    """One reminder per policy end date, to the people it grants and to the admins."""
    from app.models.pam import AccessPolicy
    from app.services.notifications import admin_ids, notify
    from app.services.settings_service import get_setting_int

    days = await get_setting_int(db, "access_expiry_notice_days")
    if days <= 0:
        return 0
    rows = (await db.execute(select(AccessPolicy).where(
        AccessPolicy.is_active.is_(True), AccessPolicy.valid_until.is_not(None),
        AccessPolicy.valid_until > now, AccessPolicy.valid_until <= now + timedelta(days=days),
        AccessPolicy.expiry_notified_at.is_(None),
    ))).scalars().all()
    admins = await admin_ids(db)
    for p in rows:
        people = {u.id for u in p.users} | {u.id for g in p.groups for u in g.users}
        when = p.valid_until.astimezone(ZoneInfo(settings.TIMEZONE)).strftime("%d/%m/%Y %H:%M")
        if people:
            await notify(db, "access.expiring", f"Votre accès « {p.name} » se termine le {when}",
                         "Faites une demande d'accès si vous en avez encore besoin.", link="/account",
                         recipients=list(people - set(admins)), level="warning")
        await notify(db, "access.expiring", f"La règle d'accès « {p.name} » se termine le {when}",
                     f"{len(people)} personne(s) concernée(s).", link="/access", recipients=admins, level="info")
        p.expiry_notified_at = now
    if rows:
        await db.commit()
    return len(rows)
