"""Reports (lot 6): users, servers and accounts over a period. Rows are plain
dicts; the API serves them as JSON (printable page in the front) or CSV."""

from datetime import datetime, timezone

from sqlalchemy import and_, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tenancy import require_org_id
from app.services.members import member_ids_subquery, members_query, roles_by_user
from app.models.audit import AuditLog
from app.models.audit_trail import CommandLog
from app.models.identity import LoginEvent, UserDevice
from app.models.pam import Account
from app.models.server import Server
from app.models.session_recording import SessionRecording
from app.models.user import User

BLOCKED = ("denied", "review")


def csv_safe(value) -> str:
    """Neutralise spreadsheet formulas (CSV injection)."""
    s = "" if value is None else str(value)
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s


def _in(col, start, end):
    return and_(col >= start, col < end)


async def users_report(db: AsyncSession, start: datetime, end: datetime) -> list[dict]:
    logins = dict((await db.execute(
        select(LoginEvent.user_id, func.count()).where(_in(LoginEvent.created_at, start, end), LoginEvent.result == "success", LoginEvent.org_id == require_org_id())
        .group_by(LoginEvent.user_id))).all())
    denied = dict((await db.execute(
        select(LoginEvent.user_id, func.count()).where(_in(LoginEvent.created_at, start, end), LoginEvent.result == "denied", LoginEvent.org_id == require_org_id())
        .group_by(LoginEvent.user_id))).all())
    sessions = dict((await db.execute(
        select(SessionRecording.user_id, func.count()).where(_in(SessionRecording.started_at, start, end))
        .group_by(SessionRecording.user_id))).all())
    cmds = {r[0]: (r[1], r[2]) for r in (await db.execute(
        select(CommandLog.user_id, func.count(), func.sum(case((CommandLog.decision.in_(BLOCKED), 1), else_=0)))
        .where(_in(CommandLog.created_at, start, end)).group_by(CommandLog.user_id))).all()}
    devices = dict((await db.execute(
        select(UserDevice.user_id, func.count()).where(UserDevice.revoked_at.is_(None), UserDevice.user_id.in_(member_ids_subquery())).group_by(UserDevice.user_id))).all())
    rows = []
    roles = await roles_by_user(db)
    for u in (await db.execute(members_query(active_only=False).order_by(User.display_name))).scalars().all():
        c = cmds.get(u.id, (0, 0))
        m = roles[u.id]
        rows.append({
            "user": u.display_name, "email": u.email, "role": m.role.value, "active": u.is_active and m.is_active,
            "last_login": u.last_login, "logins": logins.get(u.id, 0), "logins_denied": denied.get(u.id, 0),
            "sessions": sessions.get(u.id, 0), "commands": c[0] or 0, "commands_blocked": int(c[1] or 0),
            "devices": devices.get(u.id, 0),
        })
    return rows


async def servers_report(db: AsyncSession, start: datetime, end: datetime) -> list[dict]:
    sess = {r[0]: (r[1], r[2]) for r in (await db.execute(
        select(SessionRecording.server_id, func.count(), func.count(func.distinct(SessionRecording.user_id)))
        .where(_in(SessionRecording.started_at, start, end)).group_by(SessionRecording.server_id))).all()}
    cmds = {r[0]: (r[1], r[2]) for r in (await db.execute(
        select(CommandLog.server_id, func.count(), func.sum(case((CommandLog.decision.in_(BLOCKED), 1), else_=0)))
        .where(_in(CommandLog.created_at, start, end)).group_by(CommandLog.server_id))).all()}
    files = dict((await db.execute(
        select(AuditLog.server_id, func.count()).where(_in(AuditLog.timestamp, start, end), AuditLog.action.like("file.%"))
        .group_by(AuditLog.server_id))).all())
    rows = []
    for s in (await db.execute(select(Server).order_by(Server.name))).scalars().all():
        se, c = sess.get(s.id, (0, 0)), cmds.get(s.id, (0, 0))
        rows.append({
            "server": s.name, "ip": s.ip_address, "os": s.os_type.value,
            "status": s.status.value if hasattr(s.status, "value") else s.status,
            "sessions": se[0], "users": se[1], "commands": c[0] or 0, "commands_blocked": int(c[1] or 0),
            "file_transfers": files.get(s.id, 0), "accounts": len(s.accounts or []),
        })
    return rows


async def accounts_report(db: AsyncSession, start: datetime | None = None, end: datetime | None = None) -> list[dict]:
    now = datetime.now(timezone.utc)
    rows = []
    stmt = select(Account, Server.name).join(Server, Server.id == Account.server_id).order_by(Server.name, Account.username)
    for a, server_name in (await db.execute(stmt)).all():
        managed = "certificat" if a.use_cert else ("coffre" if a.credential_id else "aucun secret")
        age = (now - a.last_rotated_at).days if a.last_rotated_at else None
        rows.append({
            "server": server_name, "account": a.username, "privileged": a.privileged, "default": a.is_default,
            "active": a.is_active, "secret": managed, "rotation": a.rotation_enabled,
            "rotation_days": a.rotation_interval_days if a.rotation_enabled else None,
            "last_rotation": a.last_rotated_at, "last_rotation_status": a.last_rotation_status,
            "secret_age_days": age, "verify_status": a.verify_status, "last_verified": a.last_verified_at,
        })
    return rows


REPORTS = {
    "users": (users_report, "Rapport utilisateurs"),
    "servers": (servers_report, "Rapport serveurs"),
    "accounts": (accounts_report, "Rapport comptes"),
}
