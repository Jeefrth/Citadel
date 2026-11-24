"""Governance API (lot 3): ACL rules, approvals / access requests, notifications."""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user, require_role, has_perm, require_perm
from app.core.database import get_db
from app.core.governance import (
    Decision, approver_ids, can_approve, evaluate_command, evaluate_connection, request_approval,
)
from app.core.security import encrypt_value
from app.models.audit import AuditLog
from app.models.base import UserRole
from app.models.governance import (
    ApprovalKind, ApprovalRequest, ApprovalStatus, CommandRule, ConnectionRule, Notification,
    NotificationChannel, RuleScope,
)
from app.models.pam import Node, PolicyAction, UserGroup
from app.models.server import Server
from app.models.user import User
from app.schemas.governance import (
    AccessRequestIn, ApprovalRead, ChannelIn, ChannelRead, ChannelUpdate, CommandRuleIn,
    CommandRuleRead, CommandTestIn, ConnectionRuleIn, ConnectionRuleRead, DecisionIn, DecisionOut,
    NotificationRead, Ref,
)
from app.services import approvals as approvals_svc
from app.services.notifications import EVENTS, send_to_channel

router = APIRouter()
admin_only = require_role(UserRole.ADMIN)

RULE_LIST_FIELDS = ("user_ids", "group_ids", "server_ids", "node_ids", "approver_group_ids")


# ── Helpers ──────────────────────────────────────────────


async def _names(db: AsyncSession) -> dict[str, dict[str, str]]:
    return {
        "users": {str(i): n for i, n in (await db.execute(select(User.id, User.display_name))).all()},
        "groups": {str(i): n for i, n in (await db.execute(select(UserGroup.id, UserGroup.name))).all()},
        "servers": {str(i): n for i, n in (await db.execute(select(Server.id, Server.name))).all()},
        "nodes": {str(i): n for i, n in (await db.execute(select(Node.id, Node.name))).all()},
    }


def _refs(ids: list, names: dict[str, str]) -> list[Ref]:
    return [Ref(id=str(i), name=names.get(str(i), "(supprimé)")) for i in ids or []]


def _rule_common(r, names) -> dict:
    return dict(
        id=r.id, name=r.name, description=r.description, priority=r.priority, is_active=r.is_active,
        users=_refs(r.user_ids, names["users"]), groups=_refs(r.group_ids, names["groups"]),
        servers=_refs(r.server_ids, names["servers"]), nodes=_refs(r.node_ids, names["nodes"]),
        labels=r.labels or [], accounts=r.accounts or [],
        approver_groups=_refs(r.approver_group_ids, names["groups"]), created_at=r.created_at,
    )


def _dump_rule(data) -> dict:
    d = data.model_dump(mode="json")
    for f in RULE_LIST_FIELDS:
        d[f] = [str(x) for x in d.get(f, [])]
    return d


async def _unique_name(db: AsyncSession, model, name: str, exclude=None):
    q = select(model.id).where(model.name == name)
    if exclude:
        q = q.where(model.id != exclude)
    if (await db.execute(q)).first():
        raise HTTPException(status_code=409, detail="A rule with this name already exists")


async def _assert_no_self_lockout(db: AsyncSession, user: User, request: Request, candidate: ConnectionRule | None):
    """Refuse a login rule set that would lock the current admin out from here."""
    rules = (await db.execute(
        select(ConnectionRule).where(ConnectionRule.is_active.is_(True), ConnectionRule.scope == RuleScope.LOGIN.value)
    )).scalars().all()
    rules = [r for r in rules if candidate is None or r.id != candidate.id]
    if candidate is not None and candidate.is_active and candidate.scope == RuleScope.LOGIN.value:
        rules.append(candidate)
    rules.sort(key=lambda r: (r.priority, r.name))
    ip = getattr(request.state, "client_ip", None)
    decision = await evaluate_connection(db, user, RuleScope.LOGIN.value, ip, rules=rules)
    if decision.action != "allow":
        raise HTTPException(
            status_code=400,
            detail=f"This change would lock you out of Citadel from {ip} (rule '{decision.rule}'). "
                   "Add an allow rule for your address first.",
        )


# ── Connection rules (C3) ────────────────────────────────


def _conn_read(r: ConnectionRule, names) -> ConnectionRuleRead:
    return ConnectionRuleRead(**_rule_common(r, names), scope=r.scope, action=r.action,
                              source_ips=r.source_ips or [], time_windows=r.time_windows or [])


@router.get("/acl/connection-rules", response_model=list[ConnectionRuleRead])
async def list_connection_rules(db: AsyncSession = Depends(get_db), _: User = Depends(require_perm("policies"))):
    rows = (await db.execute(select(ConnectionRule).order_by(ConnectionRule.scope, ConnectionRule.priority, ConnectionRule.name))).scalars().all()
    names = await _names(db)
    return [_conn_read(r, names) for r in rows]


@router.post("/acl/connection-rules", response_model=ConnectionRuleRead, status_code=201)
async def create_connection_rule(data: ConnectionRuleIn, request: Request,
                                 db: AsyncSession = Depends(get_db), user: User = Depends(require_perm("policies"))):
    await _unique_name(db, ConnectionRule, data.name)
    rule = ConnectionRule(**_dump_rule(data))
    await _assert_no_self_lockout(db, user, request, rule)
    db.add(rule)
    db.add(AuditLog(user_id=user.id, action="acl.connection.create", result=data.name))
    await db.commit()
    return _conn_read(rule, await _names(db))


@router.put("/acl/connection-rules/{rule_id}", response_model=ConnectionRuleRead)
async def update_connection_rule(rule_id: uuid.UUID, data: ConnectionRuleIn, request: Request,
                                 db: AsyncSession = Depends(get_db), user: User = Depends(require_perm("policies"))):
    rule = await db.get(ConnectionRule, rule_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    await _unique_name(db, ConnectionRule, data.name, exclude=rule_id)
    for k, v in _dump_rule(data).items():
        setattr(rule, k, v)
    await _assert_no_self_lockout(db, user, request, rule)
    db.add(AuditLog(user_id=user.id, action="acl.connection.update", result=rule.name))
    await db.commit()
    return _conn_read(rule, await _names(db))


@router.delete("/acl/connection-rules/{rule_id}", status_code=204)
async def delete_connection_rule(rule_id: uuid.UUID, request: Request,
                                 db: AsyncSession = Depends(get_db), user: User = Depends(require_perm("policies"))):
    rule = await db.get(ConnectionRule, rule_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    rule.is_active = False  # check the remaining set (an allow rule may be what keeps us in)
    await _assert_no_self_lockout(db, user, request, rule)
    db.add(AuditLog(user_id=user.id, action="acl.connection.delete", result=rule.name))
    await db.delete(rule)
    await db.commit()


# ── Command rules (C5) ───────────────────────────────────


def _cmd_read(r: CommandRule, names) -> CommandRuleRead:
    return CommandRuleRead(**_rule_common(r, names), action=r.action, patterns=r.patterns or [])


@router.get("/acl/command-rules", response_model=list[CommandRuleRead])
async def list_command_rules(db: AsyncSession = Depends(get_db), _: User = Depends(require_perm("policies"))):
    rows = (await db.execute(select(CommandRule).order_by(CommandRule.priority, CommandRule.name))).scalars().all()
    names = await _names(db)
    return [_cmd_read(r, names) for r in rows]


@router.post("/acl/command-rules", response_model=CommandRuleRead, status_code=201)
async def create_command_rule(data: CommandRuleIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_perm("policies"))):
    await _unique_name(db, CommandRule, data.name)
    rule = CommandRule(**_dump_rule(data))
    db.add(rule)
    db.add(AuditLog(user_id=user.id, action="acl.command.create", result=data.name))
    await db.commit()
    return _cmd_read(rule, await _names(db))


@router.put("/acl/command-rules/{rule_id}", response_model=CommandRuleRead)
async def update_command_rule(rule_id: uuid.UUID, data: CommandRuleIn,
                              db: AsyncSession = Depends(get_db), user: User = Depends(require_perm("policies"))):
    rule = await db.get(CommandRule, rule_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    await _unique_name(db, CommandRule, data.name, exclude=rule_id)
    for k, v in _dump_rule(data).items():
        setattr(rule, k, v)
    db.add(AuditLog(user_id=user.id, action="acl.command.update", result=rule.name))
    await db.commit()
    return _cmd_read(rule, await _names(db))


@router.delete("/acl/command-rules/{rule_id}", status_code=204)
async def delete_command_rule(rule_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_perm("policies"))):
    rule = await db.get(CommandRule, rule_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    db.add(AuditLog(user_id=user.id, action="acl.command.delete", result=rule.name))
    await db.delete(rule)
    await db.commit()


@router.post("/acl/command-rules/test", response_model=DecisionOut)
async def test_command(data: CommandTestIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_perm("policies"))):
    """Dry run: what would happen if this user ran this command on this server?"""
    target_user = await db.get(User, data.user_id) if data.user_id else user
    server = await db.get(Server, data.server_id)
    if not target_user or not server:
        raise HTTPException(status_code=404, detail="User or server not found")
    d = await evaluate_command(db, target_user, server, data.account, data.command)
    return DecisionOut(action=d.action, rule=d.rule, reason=d.reason)


# ── Approvals (G2) and access requests (G1) ──────────────


async def _approval_read(db: AsyncSession, r: ApprovalRequest, viewer: User, names=None) -> ApprovalRead:
    names = names or await _names(db)
    users, servers = names["users"], names["servers"]
    return ApprovalRead(
        id=r.id, number=r.number, kind=r.kind, status=r.status,
        requester=Ref(id=str(r.requester_id), name=users.get(str(r.requester_id), "?")),
        server=Ref(id=str(r.server_id), name=servers.get(str(r.server_id), "?")) if r.server_id else None,
        account_username=r.account_username, command=r.command, reason=r.reason, payload=r.payload or {},
        rule_name=r.rule_name,
        decided_by=Ref(id=str(r.decided_by), name=users.get(str(r.decided_by), "?")) if r.decided_by else None,
        decided_at=r.decided_at, decision_comment=r.decision_comment, expires_at=r.expires_at,
        grant_until=r.grant_until, used_at=r.used_at, policy_id=r.policy_id, created_at=r.created_at,
        can_decide=r.status == ApprovalStatus.PENDING.value and await can_approve(db, viewer, r),
        approvers_available=len(await approver_ids(db, r.approver_group_ids, exclude=r.requester_id)),
    )


@router.get("/approvals", response_model=list[ApprovalRead])
async def list_approvals(
    scope: str = Query(default="todo", pattern="^(todo|mine|all)$"),
    status: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
):
    q = select(ApprovalRequest).order_by(ApprovalRequest.created_at.desc()).limit(limit)
    if status:
        q = q.where(ApprovalRequest.status == status)
    if scope == "mine":
        q = q.where(ApprovalRequest.requester_id == user.id)
    elif scope == "all":
        if user.role != UserRole.ADMIN:
            raise HTTPException(status_code=403, detail="Admins only")
    else:  # todo: pending requests this user may decide
        q = q.where(ApprovalRequest.status == ApprovalStatus.PENDING.value,
                    ApprovalRequest.requester_id != user.id)
    rows = (await db.execute(q)).scalars().all()
    names = await _names(db)
    out = [await _approval_read(db, r, user, names) for r in rows]
    if scope == "todo":
        out = [a for a in out if a.can_decide]
    return out


@router.get("/approvals/pending-count")
async def pending_count(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    rows = (await db.execute(select(ApprovalRequest).where(
        ApprovalRequest.status == ApprovalStatus.PENDING.value, ApprovalRequest.requester_id != user.id))).scalars().all()
    return {"count": sum([1 for r in rows if await can_approve(db, user, r)])}


async def _get_request(db: AsyncSession, request_id: uuid.UUID) -> ApprovalRequest:
    r = await db.get(ApprovalRequest, request_id)
    if not r:
        raise HTTPException(status_code=404, detail="Request not found")
    return r


@router.get("/approvals/{request_id}", response_model=ApprovalRead)
async def get_approval(request_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    r = await _get_request(db, request_id)
    if user.role != UserRole.ADMIN and str(r.requester_id) != str(user.id) and not await can_approve(db, user, r):
        raise HTTPException(status_code=404, detail="Request not found")
    return await _approval_read(db, r, user)


@router.post("/approvals/{request_id}/approve", response_model=ApprovalRead)
async def approve(request_id: uuid.UUID, data: DecisionIn, db: AsyncSession = Depends(get_db),
                  user: User = Depends(get_current_user)):
    r = await approvals_svc.decide(db, user, await _get_request(db, request_id), True, data.comment)
    return await _approval_read(db, r, user)


@router.post("/approvals/{request_id}/reject", response_model=ApprovalRead)
async def reject(request_id: uuid.UUID, data: DecisionIn, db: AsyncSession = Depends(get_db),
                 user: User = Depends(get_current_user)):
    r = await approvals_svc.decide(db, user, await _get_request(db, request_id), False, data.comment)
    return await _approval_read(db, r, user)


@router.post("/approvals/{request_id}/cancel", response_model=ApprovalRead)
async def cancel(request_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    r = await approvals_svc.cancel(db, user, await _get_request(db, request_id))
    return await _approval_read(db, r, user)


@router.post("/access-requests", response_model=ApprovalRead, status_code=201)
async def create_access_request(data: AccessRequestIn, db: AsyncSession = Depends(get_db),
                                user: User = Depends(get_current_user)):
    """Ask for temporary access (G1). Approved => a time-boxed access policy."""
    if not data.server_ids and not data.node_ids:
        raise HTTPException(status_code=400, detail="Choose at least one server or node")
    allowed_actions = {a.value for a in PolicyAction}
    if set(data.actions) - allowed_actions:
        raise HTTPException(status_code=400, detail=f"Unknown actions: {sorted(set(data.actions) - allowed_actions)}")
    if data.server_ids:
        found = (await db.execute(select(func.count(Server.id)).where(Server.id.in_(data.server_ids)))).scalar_one()
        if found != len(set(data.server_ids)):
            raise HTTPException(status_code=400, detail="Unknown server in request")
    if data.node_ids:
        found = (await db.execute(select(func.count(Node.id)).where(Node.id.in_(data.node_ids)))).scalar_one()
        if found != len(set(data.node_ids)):
            raise HTTPException(status_code=400, detail="Unknown node in request")
    payload = {
        "server_ids": [str(s) for s in data.server_ids], "node_ids": [str(n) for n in data.node_ids],
        "actions": sorted(set(data.actions)), "accounts": data.accounts, "duration_hours": data.duration_hours,
    }
    req = await request_approval(db, user, ApprovalKind.ACCESS.value, Decision("review", None, []),
                                 reason=data.reason, payload=payload)
    db.add(AuditLog(user_id=user.id, action="access.request", result=f"#{req.number} {data.duration_hours}h"))
    await db.commit()
    return await _approval_read(db, req, user)


@router.get("/access-requests/servers", response_model=list[Ref])
async def requestable_servers(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """All servers (names only) so users can ask for access to servers they cannot see yet."""
    rows = (await db.execute(select(Server.id, Server.name).order_by(Server.name))).all()
    return [Ref(id=str(i), name=n) for i, n in rows]


@router.get("/access-requests/nodes", response_model=list[Ref])
async def requestable_nodes(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    from app.api.servers import node_paths
    paths = await node_paths(db)
    return sorted([Ref(id=str(i), name=p) for i, p in paths.items()], key=lambda r: r.name.lower())


# ── Notifications (G4) ───────────────────────────────────


@router.get("/notifications", response_model=list[NotificationRead])
async def my_notifications(unread_only: bool = False, limit: int = Query(default=50, ge=1, le=200),
                           db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(Notification).where(Notification.user_id == user.id)
    if unread_only:
        q = q.where(Notification.read_at.is_(None))
    return (await db.execute(q.order_by(Notification.created_at.desc()).limit(limit))).scalars().all()


@router.get("/notifications/unread-count")
async def unread_count(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    n = (await db.execute(select(func.count(Notification.id)).where(
        Notification.user_id == user.id, Notification.read_at.is_(None)))).scalar_one()
    return {"count": n}


@router.post("/notifications/{notification_id}/read", status_code=204)
async def mark_read(notification_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    await db.execute(update(Notification).where(
        Notification.id == notification_id, Notification.user_id == user.id, Notification.read_at.is_(None)
    ).values(read_at=datetime.now(timezone.utc)))
    await db.commit()


@router.post("/notifications/read-all", status_code=204)
async def mark_all_read(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    await db.execute(update(Notification).where(
        Notification.user_id == user.id, Notification.read_at.is_(None)
    ).values(read_at=datetime.now(timezone.utc)))
    await db.commit()


@router.get("/notification-events")
async def notification_events(_: User = Depends(get_current_user)):
    return [{"event": k, "label": v} for k, v in EVENTS.items()]


def _channel_read(c: NotificationChannel) -> ChannelRead:
    return ChannelRead(id=c.id, name=c.name, type=c.type, is_active=c.is_active, config=c.config or {},
                       has_secret=bool(c.encrypted_secret), events=c.events or [], min_level=c.min_level,
                       last_sent_at=c.last_sent_at, last_error=c.last_error, created_at=c.created_at)


def _check_channel(type_: str, config: dict, secret: str | None, has_secret: bool) -> None:
    if type_ in ("teams", "webhook"):
        if secret is not None and not secret.startswith(("https://", "http://")):
            raise HTTPException(status_code=400, detail="Webhook URL must start with https://")
        if secret is None and not has_secret:
            raise HTTPException(status_code=400, detail="Webhook URL is required")
    if type_ == "email" and not (config or {}).get("host"):
        raise HTTPException(status_code=400, detail="SMTP host is required")


@router.get("/notification-channels", response_model=list[ChannelRead])
async def list_channels(db: AsyncSession = Depends(get_db), _: User = Depends(admin_only)):
    rows = (await db.execute(select(NotificationChannel).order_by(NotificationChannel.name))).scalars().all()
    return [_channel_read(c) for c in rows]


@router.post("/notification-channels", response_model=ChannelRead, status_code=201)
async def create_channel(data: ChannelIn, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    _check_channel(data.type.value, data.config, data.secret, False)
    if [e for e in data.events if e not in EVENTS]:
        raise HTTPException(status_code=400, detail="Unknown event in subscription")
    if (await db.execute(select(NotificationChannel.id).where(NotificationChannel.name == data.name))).first():
        raise HTTPException(status_code=409, detail="A channel with this name already exists")
    ch = NotificationChannel(name=data.name, type=data.type.value, is_active=data.is_active, config=data.config,
                             encrypted_secret=encrypt_value(data.secret) if data.secret else None,
                             events=data.events, min_level=data.min_level)
    db.add(ch)
    db.add(AuditLog(user_id=user.id, action="notification_channel.create", result=data.name))
    await db.commit()
    return _channel_read(ch)


@router.patch("/notification-channels/{channel_id}", response_model=ChannelRead)
async def update_channel(channel_id: uuid.UUID, data: ChannelUpdate, db: AsyncSession = Depends(get_db),
                         user: User = Depends(admin_only)):
    ch = await db.get(NotificationChannel, channel_id)
    if not ch:
        raise HTTPException(status_code=404, detail="Channel not found")
    changes = data.model_dump(exclude_unset=True)
    _check_channel(ch.type, changes.get("config", ch.config), changes.get("secret"), bool(ch.encrypted_secret))
    if "events" in changes and [e for e in changes["events"] if e not in EVENTS]:
        raise HTTPException(status_code=400, detail="Unknown event in subscription")
    secret = changes.pop("secret", None)
    if secret:
        ch.encrypted_secret = encrypt_value(secret)
    for k, v in changes.items():
        setattr(ch, k, v)
    db.add(AuditLog(user_id=user.id, action="notification_channel.update", result=ch.name))
    await db.commit()
    return _channel_read(ch)


@router.delete("/notification-channels/{channel_id}", status_code=204)
async def delete_channel(channel_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    ch = await db.get(NotificationChannel, channel_id)
    if not ch:
        raise HTTPException(status_code=404, detail="Channel not found")
    db.add(AuditLog(user_id=user.id, action="notification_channel.delete", result=ch.name))
    await db.delete(ch)
    await db.commit()


@router.post("/notification-channels/{channel_id}/test")
async def test_channel(channel_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    ch = await db.get(NotificationChannel, channel_id)
    if not ch:
        raise HTTPException(status_code=404, detail="Channel not found")
    try:
        await send_to_channel(ch, "test", "Message de test",
                              f"Canal « {ch.name} » configuré par {user.display_name}.", "/settings", "info",
                              [user.email] if user.email and "@" in user.email else [])
        ch.last_sent_at = datetime.now(timezone.utc)
        ch.last_error = None
        ok, message = True, "Message envoyé"
    except Exception as e:  # noqa: BLE001
        ch.last_error = f"{type(e).__name__}: {e}"[:500]
        ok, message = False, ch.last_error
    await db.commit()
    return {"ok": ok, "message": message}
