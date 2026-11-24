"""Approval decisions (G2) and temporary access requests (G1)."""

import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.governance import can_approve
from app.models.audit import AuditLog
from app.models.governance import ApprovalKind, ApprovalRequest, ApprovalStatus
from app.models.pam import AccessPolicy, Node
from app.models.server import Server
from app.models.user import User
from app.services.notifications import notify


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def decide(db: AsyncSession, user: User, req: ApprovalRequest, approve: bool, comment: str | None) -> ApprovalRequest:
    if req.status != ApprovalStatus.PENDING.value:
        raise HTTPException(status_code=409, detail=f"Request is already {req.status}")
    if req.expires_at < _now():
        req.status = ApprovalStatus.EXPIRED.value
        await db.commit()
        raise HTTPException(status_code=409, detail="Request has expired")
    if not await can_approve(db, user, req):
        raise HTTPException(status_code=403, detail="You cannot decide on this request (four-eyes rule or not an approver)")

    req.decided_by = user.id
    req.decided_at = _now()
    req.decision_comment = comment
    if not approve:
        req.status = ApprovalStatus.REJECTED.value
    else:
        req.status = ApprovalStatus.APPROVED.value
        if req.kind == ApprovalKind.CONNECT.value:
            req.grant_until = _now() + timedelta(minutes=settings.CONNECT_GRANT_MINUTES)
        elif req.kind == ApprovalKind.COMMAND.value:
            req.grant_until = _now() + timedelta(minutes=settings.COMMAND_GRANT_MINUTES)
        elif req.kind == ApprovalKind.ACCESS.value:
            await _grant_access(db, req, user)

    db.add(AuditLog(user_id=user.id, server_id=req.server_id,
                    action=f"approval.{'approve' if approve else 'reject'}",
                    result=f"#{req.number} {req.kind}" + (f": {comment}" if comment else "")))
    verdict = "approuvée" if approve else "refusée"
    extra = ""
    if approve and req.grant_until:
        local = req.grant_until.astimezone(ZoneInfo(settings.TIMEZONE))
        extra = f" Valable jusqu'au {local.strftime('%d/%m %H:%M')}."
    await notify(db, "approval.decided", f"Demande #{req.number} {verdict}",
                 f"{user.display_name} a {verdict} votre demande.{extra}"
                 + (f" Commentaire : {comment}" if comment else ""),
                 link=f"/approvals?id={req.id}", recipients=[req.requester_id],
                 level="info" if approve else "warning")
    await db.commit()
    return req


async def cancel(db: AsyncSession, user: User, req: ApprovalRequest) -> ApprovalRequest:
    if str(req.requester_id) != str(user.id):
        raise HTTPException(status_code=403, detail="Only the requester can cancel")
    if req.status not in (ApprovalStatus.PENDING.value, ApprovalStatus.APPROVED.value):
        raise HTTPException(status_code=409, detail=f"Request is already {req.status}")
    req.status = ApprovalStatus.CANCELLED.value
    if req.policy_id:  # give back a temporary access early
        policy = await db.get(AccessPolicy, req.policy_id)
        if policy:
            policy.is_active = False
    await db.commit()
    return req


async def _grant_access(db: AsyncSession, req: ApprovalRequest, approver: User) -> None:
    p = req.payload or {}
    hours = int(p.get("duration_hours") or 8)
    requester = await db.get(User, req.requester_id)
    servers = (await db.execute(select(Server).where(Server.id.in_(
        [uuid.UUID(s) for s in p.get("server_ids", [])])))).scalars().all() if p.get("server_ids") else []
    nodes = (await db.execute(select(Node).where(Node.id.in_(
        [uuid.UUID(n) for n in p.get("node_ids", [])])))).scalars().all() if p.get("node_ids") else []
    policy = AccessPolicy(
        name=f"Demande #{req.number} ({requester.display_name if requester else req.requester_id})"[:255],
        description=f"Accès temporaire approuvé par {approver.display_name}. Motif : {req.reason or '-'}"[:500],
        is_active=True, valid_from=_now(), valid_until=_now() + timedelta(hours=hours),
        actions=p.get("actions") or ["connect"], accounts=p.get("accounts") or ["@ALL"],
        labels=[], created_by=approver.id,
    )
    policy.users = [requester] if requester else []
    policy.servers = list(servers)
    policy.nodes = list(nodes)
    db.add(policy)
    await db.flush()
    req.policy_id = policy.id
    req.grant_until = policy.valid_until


async def consume_command_grant(db: AsyncSession, grant: ApprovalRequest) -> None:
    grant.status = ApprovalStatus.USED.value
    grant.used_at = _now()
    await db.commit()


async def expire_pending(db: AsyncSession) -> int:
    res = await db.execute(
        update(ApprovalRequest)
        .where(ApprovalRequest.status == ApprovalStatus.PENDING.value, ApprovalRequest.expires_at < _now())
        .values(status=ApprovalStatus.EXPIRED.value)
    )
    await db.commit()
    return res.rowcount or 0
