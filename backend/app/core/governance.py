"""Governance engine (lot 3).

- Connection ACL (C3): ordered rules (priority asc), first match wins,
  no match = allow (access policies still decide visibility/actions).
- Command ACL (C5): global blocklist (settings) first, then ordered rules.
- Approvals (G2): "review" creates an ApprovalRequest; once approved, a
  connection grant is reusable until grant_until, a command grant is one-shot.
  The requester can never approve their own request (four eyes).
"""

import ipaddress
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.permissions import _label_matches, node_descendants
from app.models.base import UserRole
from app.models.governance import (
    ApprovalKind, ApprovalRequest, ApprovalStatus, CommandAction, CommandRule, ConnectAction,
    ConnectionRule, RuleScope,
)
from app.models.pam import Node, user_group_members
from app.models.server import Server
from app.models.user import User

logger = logging.getLogger("citadel.governance")


# ── Client IP ────────────────────────────────────────────


def _trusted_proxies() -> list:
    out = []
    for cidr in settings.TRUSTED_PROXIES.split(","):
        cidr = cidr.strip()
        if cidr:
            try:
                out.append(ipaddress.ip_network(cidr, strict=False))
            except ValueError:
                logger.warning("invalid TRUSTED_PROXIES entry: %s", cidr)
    return out


def client_ip(peer: str | None, headers) -> str | None:
    """Real client IP. X-Forwarded-For is only honoured from a trusted proxy."""
    if not peer:
        return None
    try:
        peer_ip = ipaddress.ip_address(peer)
    except ValueError:
        return peer
    proxies = _trusted_proxies()
    if proxies and any(peer_ip in net for net in proxies):
        xff = headers.get("x-forwarded-for") if headers else None
        if xff:
            # Right-most address not belonging to a trusted proxy
            for hop in reversed([h.strip() for h in xff.split(",") if h.strip()]):
                try:
                    hop_ip = ipaddress.ip_address(hop)
                except ValueError:
                    continue
                if not any(hop_ip in net for net in proxies):
                    return hop
    return peer


# ── Matching helpers ─────────────────────────────────────


@dataclass
class Subject:
    user: User
    group_ids: set[str]


@dataclass
class Target:
    server_id: str | None = None
    node_ancestry: set[str] | None = None  # node of the server + its ancestors
    tags: dict | None = None
    account: str | None = None


async def load_subject(db: AsyncSession, user: User) -> Subject:
    rows = await db.execute(select(user_group_members.c.group_id).where(user_group_members.c.user_id == user.id))
    return Subject(user=user, group_ids={str(r[0]) for r in rows.all()})


async def load_target(db: AsyncSession, server: Server, account: str | None) -> Target:
    ancestry: set[str] = set()
    if server.node_id:
        nodes = {r[0]: r[1] for r in (await db.execute(select(Node.id, Node.parent_id))).all()}
        cur, guard = server.node_id, 0
        while cur is not None and guard < 100:
            ancestry.add(str(cur))
            cur, guard = nodes.get(cur), guard + 1
    return Target(server_id=str(server.id), node_ancestry=ancestry, tags=server.tags or {}, account=account)


def _subject_matches(rule, subject: Subject) -> bool:
    if not rule.user_ids and not rule.group_ids:
        return True
    return str(subject.user.id) in set(rule.user_ids) or bool(subject.group_ids & set(rule.group_ids))


def _target_matches(rule, target: Target | None) -> bool:
    if not (rule.server_ids or rule.node_ids or rule.labels):
        server_ok = True
    elif target is None or target.server_id is None:
        server_ok = False
    else:
        server_ok = (
            target.server_id in set(rule.server_ids)
            or bool((target.node_ancestry or set()) & set(rule.node_ids))
            or _label_matches(target.tags, rule.labels)
        )
    if not server_ok:
        return False
    if rule.accounts and (target is None or target.account not in set(rule.accounts)):
        return False
    return True


def _ip_matches(cidrs: list, ip: str | None) -> bool:
    if not cidrs:
        return True
    if not ip:
        return False
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    for c in cidrs:
        try:
            if addr in ipaddress.ip_network(c, strict=False):
                return True
        except ValueError:
            continue
    return False


def _parse_hhmm(v: str) -> time:
    h, m = v.split(":")
    return time(int(h), int(m))


def time_matches(windows: list, now: datetime | None = None) -> bool:
    """True if now (in settings.TIMEZONE) is inside any window. Overnight windows allowed."""
    if not windows:
        return True
    local = (now or datetime.now(timezone.utc)).astimezone(ZoneInfo(settings.TIMEZONE))
    t, day = local.time(), local.weekday()
    for w in windows:
        days = w.get("days") or list(range(7))
        start, end = _parse_hhmm(w.get("start", "00:00")), _parse_hhmm(w.get("end", "23:59"))
        if start <= end:
            if day in days and start <= t <= end:
                return True
        else:  # e.g. 22:00 -> 06:00: the morning part belongs to the previous day's window
            if (day in days and t >= start) or (((day - 1) % 7) in days and t <= end):
                return True
    return False


# ── Connection ACL (C3) ──────────────────────────────────


@dataclass
class Decision:
    action: str
    rule: str | None = None
    approver_group_ids: list | None = None
    reason: str | None = None


async def evaluate_connection(
    db: AsyncSession, user: User, scope: str, ip: str | None,
    server: Server | None = None, account: str | None = None,
    rules: list[ConnectionRule] | None = None, now: datetime | None = None,
) -> Decision:
    if rules is None:
        rules = (await db.execute(
            select(ConnectionRule).where(ConnectionRule.is_active.is_(True), ConnectionRule.scope == scope)
            .order_by(ConnectionRule.priority, ConnectionRule.name)
        )).scalars().all()
    if not rules:
        return Decision(ConnectAction.ALLOW.value)
    subject = await load_subject(db, user)
    target = await load_target(db, server, account) if server is not None else None
    for rule in rules:
        if rule.scope != scope or not rule.is_active:
            continue
        if not _subject_matches(rule, subject):
            continue
        if scope == RuleScope.CONNECT.value and not _target_matches(rule, target):
            continue
        if not _ip_matches(rule.source_ips, ip) or not time_matches(rule.time_windows, now):
            continue
        action = rule.action
        if scope == RuleScope.LOGIN.value and action == ConnectAction.REVIEW.value:
            action = ConnectAction.DENY.value  # review makes no sense for API login
        return Decision(action, rule.name, list(rule.approver_group_ids or []))
    return Decision(ConnectAction.ALLOW.value)


# ── Command ACL (C5) ─────────────────────────────────────


def _pattern_hits(patterns: list, command: str) -> str | None:
    for p in patterns:
        try:
            if re.search(p, command, re.IGNORECASE):
                return p
        except re.error:
            continue
    return None


async def evaluate_command(
    db: AsyncSession, user: User, server: Server, account: str | None, command: str,
) -> Decision:
    from app.core.command_filter import check_command

    cmd = command.strip()
    if not cmd:
        return Decision(CommandAction.ALLOW.value)
    allowed, reason = await check_command(cmd, db)
    if not allowed:
        return Decision(CommandAction.DENY.value, "Liste de blocage globale", reason=reason)
    rules = (await db.execute(
        select(CommandRule).where(CommandRule.is_active.is_(True))
        .order_by(CommandRule.priority, CommandRule.name)
    )).scalars().all()
    if not rules:
        return Decision(CommandAction.ALLOW.value)
    subject = await load_subject(db, user)
    target = await load_target(db, server, account)
    for rule in rules:
        if not _subject_matches(rule, subject) or not _target_matches(rule, target):
            continue
        hit = _pattern_hits(rule.patterns or [], cmd)
        if hit is None:
            continue
        return Decision(rule.action, rule.name, list(rule.approver_group_ids or []), reason=hit)
    return Decision(CommandAction.ALLOW.value)


# ── Approvals (G2) ───────────────────────────────────────


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def approver_ids(db: AsyncSession, approver_group_ids: list, exclude=None) -> list:
    if approver_group_ids:
        rows = await db.execute(
            select(user_group_members.c.user_id)
            .where(user_group_members.c.group_id.in_([uuid.UUID(str(g)) for g in approver_group_ids]))
        )
        ids = [r[0] for r in rows.all()]
    else:
        ids = [r[0] for r in (await db.execute(
            select(User.id).where(User.role == UserRole.ADMIN, User.is_active.is_(True)))).all()]
    return [i for i in dict.fromkeys(ids) if exclude is None or str(i) != str(exclude)]


async def can_approve(db: AsyncSession, user: User, request: ApprovalRequest) -> bool:
    if str(user.id) == str(request.requester_id):
        return False  # four eyes, always
    return str(user.id) in {str(i) for i in await approver_ids(db, request.approver_group_ids)}


async def find_grant(
    db: AsyncSession, user: User, kind: str, server_id, account: str | None, command: str | None = None,
) -> ApprovalRequest | None:
    q = select(ApprovalRequest).where(
        ApprovalRequest.requester_id == user.id,
        ApprovalRequest.kind == kind,
        ApprovalRequest.server_id == server_id,
        ApprovalRequest.status == ApprovalStatus.APPROVED.value,
        ApprovalRequest.grant_until >= _now(),
    )
    if account is not None:
        q = q.where(ApprovalRequest.account_username == account)
    if command is not None:
        q = q.where(ApprovalRequest.command == command.strip())
    return (await db.execute(q.order_by(ApprovalRequest.decided_at.desc()).limit(1))).scalar_one_or_none()


async def request_approval(
    db: AsyncSession, user: User, kind: str, decision: Decision, server: Server | None = None,
    account: str | None = None, command: str | None = None, reason: str | None = None,
    payload: dict | None = None,
) -> ApprovalRequest:
    """Create (or reuse an identical pending) approval request and notify approvers. Commits."""
    from app.services.notifications import notify

    existing = (await db.execute(select(ApprovalRequest).where(
        ApprovalRequest.requester_id == user.id, ApprovalRequest.kind == kind,
        ApprovalRequest.status == ApprovalStatus.PENDING.value,
        ApprovalRequest.server_id == (server.id if server else None),
        ApprovalRequest.account_username == account,
        ApprovalRequest.command == (command.strip() if command else None),
        ApprovalRequest.expires_at >= _now(),
    ).limit(1))).scalar_one_or_none()
    if existing and kind != ApprovalKind.ACCESS.value:
        return existing

    req = ApprovalRequest(
        kind=kind, requester_id=user.id, server_id=server.id if server else None,
        account_username=account, command=command.strip() if command else None,
        reason=reason, payload=payload or {}, rule_name=decision.rule,
        approver_group_ids=decision.approver_group_ids or [],
        expires_at=_now() + timedelta(hours=settings.APPROVAL_PENDING_HOURS),
    )
    db.add(req)
    await db.flush()
    await db.refresh(req, attribute_names=["number"])
    what = {
        ApprovalKind.CONNECT.value: f"connexion à {server.name if server else '?'} ({account})",
        ApprovalKind.COMMAND.value: f"commande sur {server.name if server else '?'} : {command}",
        ApprovalKind.ACCESS.value: "accès temporaire",
    }[kind]
    recipients = await approver_ids(db, req.approver_group_ids, exclude=user.id)
    await notify(
        db, "approval.requested", f"Demande #{req.number} : {what}"[:255],
        f"{user.display_name} demande une validation"
        + (f" (règle « {decision.rule} »)" if decision.rule else "")
        + (f". Motif : {reason}" if reason else "."),
        link=f"/approvals?id={req.id}", recipients=recipients, level="warning",
    )
    await db.commit()
    return req
