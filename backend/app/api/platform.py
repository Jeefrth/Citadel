"""Platform console (SaaS phase 2): what a platform admin needs to run the
service, without entering each organisation: activity per organisation and the
platform's own journal."""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.orgs import require_platform_admin
from app.core import tenancy
from app.core.database import get_db
from app.models.audit import AuditLog
from app.models.auth import AuthSession
from app.models.kubernetes import K8sCluster
from app.models.organization import OrgInvitation, OrgMembership, Organization
from app.models.server import Server
from app.models.session_recording import SessionRecording
from app.models.user import User

router = APIRouter()

PLATFORM_ACTIONS = ("org.", "idp.", "ip_allowlist.bypass")


@router.get("/platform/overview")
async def overview(db: AsyncSession = Depends(get_db), _: User = Depends(require_platform_admin)):
    """Counters per organisation and for the platform (read across organisations)."""
    from app.services import live
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=30)
    async with tenancy.system_in(db):
        members = dict((await db.execute(select(OrgMembership.org_id, func.count()).where(
            OrgMembership.is_active.is_(True)).group_by(OrgMembership.org_id))).all())
        invites = dict((await db.execute(select(OrgInvitation.org_id, func.count()).group_by(OrgInvitation.org_id))).all())
        servers = dict((await db.execute(select(Server.org_id, func.count()).group_by(Server.org_id))).all())
        clusters = dict((await db.execute(select(K8sCluster.org_id, func.count()).group_by(K8sCluster.org_id))).all())
        sess = {r[0]: (r[1], r[2] or 0, r[3]) for r in (await db.execute(
            select(SessionRecording.org_id, func.count(), func.sum(SessionRecording.size_bytes), func.max(SessionRecording.started_at))
            .where(SessionRecording.started_at >= since).group_by(SessionRecording.org_id))).all()}
        storage = dict((await db.execute(select(SessionRecording.org_id, func.sum(SessionRecording.size_bytes))
                                         .group_by(SessionRecording.org_id))).all())
        last_audit = dict((await db.execute(select(AuditLog.org_id, func.max(AuditLog.timestamp))
                                            .where(AuditLog.org_id.is_not(None)).group_by(AuditLog.org_id))).all())
        orgs = (await db.execute(select(Organization).order_by(Organization.is_default.desc(), Organization.name))).scalars().all()
        users = (await db.execute(select(func.count(User.id)).where(User.is_active.is_(True)))).scalar_one()
        active_sessions = (await db.execute(select(func.count(AuthSession.id)).where(
            AuthSession.revoked_at.is_(None), AuthSession.expires_at > now))).scalar_one()
        live_all = await live.list_active()
    live_by_org: dict = {}
    for m in live_all:
        live_by_org[m.get("org_id")] = live_by_org.get(m.get("org_id"), 0) + 1
    rows = []
    for o in orgs:
        s = sess.get(o.id, (0, 0, None))
        rows.append({"id": str(o.id), "name": o.name, "slug": o.slug, "is_active": o.is_active, "is_default": o.is_default,
                     "members": members.get(o.id, 0), "pending_invitations": invites.get(o.id, 0),
                     "servers": servers.get(o.id, 0), "clusters": clusters.get(o.id, 0),
                     "sessions_30d": s[0], "last_session_at": s[2], "live_sessions": live_by_org.get(str(o.id), 0),
                     "recordings_bytes": int(storage.get(o.id) or 0), "last_activity_at": last_audit.get(o.id)})
    return {"organisations": rows,
            "totals": {"organisations": len(orgs), "active_organisations": sum(1 for o in orgs if o.is_active),
                       "people": users, "signed_in_sessions": active_sessions, "live_sessions": len(live_all),
                       "servers": sum(r["servers"] for r in rows), "sessions_30d": sum(r["sessions_30d"] for r in rows)}}


@router.get("/platform/audit")
async def platform_audit(limit: int = Query(default=100, ge=1, le=1000), offset: int = Query(default=0, ge=0),
                         db: AsyncSession = Depends(get_db), _: User = Depends(require_platform_admin)):
    """Platform journal: organisations, identity providers, platform settings,
    sign-ins of platform admins outside an organisation's allow-list."""
    cond = or_(AuditLog.org_id.is_(None), *[AuditLog.action.like(p + "%") for p in PLATFORM_ACTIONS])
    async with tenancy.system_in(db):
        total = (await db.execute(select(func.count(AuditLog.id)).where(cond))).scalar_one()
        rows = (await db.execute(select(AuditLog, User.display_name, Organization.name)
                                 .outerjoin(User, User.id == AuditLog.user_id)
                                 .outerjoin(Organization, Organization.id == AuditLog.org_id)
                                 .where(cond).order_by(AuditLog.timestamp.desc()).limit(limit).offset(offset))).all()
    return {"total": total, "items": [
        {"id": str(a.id), "timestamp": a.timestamp, "action": a.action, "status": a.status, "user": name,
         "organisation": org_name, "ip_address": a.ip_address, "result": a.result} for a, name, org_name in rows]}
