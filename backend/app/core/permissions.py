"""Access policy evaluation (C1) and account resolution (B1, B9).

Rules:
- Admins bypass policies: every server, every action, every account.
- Other users only see servers granted by at least one active, in-validity
  AccessPolicy targeting them directly or through a UserGroup.
- A policy selects servers directly, through nodes (including descendants)
  and through label selectors ("key=value", any match).
- Grants from several policies are merged (union of actions and accounts).
- The user role is a ceiling: a viewer never gets "execute".
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import encrypt_value
from app.models.base import CredentialType, OSType, UserRole
from app.models.pam import (
    ACCOUNT_ALL, ACCOUNT_INPUT, ACCOUNT_USER, VIRTUAL_ACCOUNTS,
    AccessPolicy, Account, Node, PolicyAction, policy_groups, policy_users,
    user_group_members,
)
from app.models.server import Server
from app.models.user import User

ALL_ACTIONS = {a.value for a in PolicyAction}


@dataclass
class ServerGrant:
    actions: set[str] = field(default_factory=set)
    accounts: set[str] = field(default_factory=set)
    policies: set[str] = field(default_factory=set)

    def allows_account(self, username: str) -> bool:
        return ACCOUNT_ALL in self.accounts or username in self.accounts


ADMIN_GRANT = ServerGrant(actions=set(ALL_ACTIONS), accounts=set(VIRTUAL_ACCOUNTS), policies={"admin"})


def _role_ceiling(user: User, actions: set[str]) -> set[str]:
    """Viewers can look, connect and download, never change anything on a server."""
    if user.role == UserRole.VIEWER:
        return actions - {PolicyAction.EXECUTE.value, PolicyAction.UPLOAD.value}
    return actions


def _label_matches(tags: dict | None, selectors: list[str]) -> bool:
    if not tags or not selectors:
        return False
    for sel in selectors:
        key, _, value = sel.partition("=")
        if key in tags and (value == "" or str(tags[key]) == value):
            return True
    return False


def node_descendants(nodes: list[tuple[uuid.UUID, uuid.UUID | None]], roots: set[uuid.UUID]) -> set[uuid.UUID]:
    children: dict[uuid.UUID | None, list[uuid.UUID]] = {}
    for nid, parent in nodes:
        children.setdefault(parent, []).append(nid)
    result: set[uuid.UUID] = set()
    stack = list(roots)
    while stack:
        nid = stack.pop()
        if nid in result:
            continue
        result.add(nid)
        stack.extend(children.get(nid, []))
    return result


async def active_policies_for(db: AsyncSession, user: User) -> list[AccessPolicy]:
    now = datetime.now(timezone.utc)
    group_ids = select(user_group_members.c.group_id).where(user_group_members.c.user_id == user.id)
    by_user = select(policy_users.c.policy_id).where(policy_users.c.user_id == user.id)
    by_group = select(policy_groups.c.policy_id).where(policy_groups.c.group_id.in_(group_ids))
    result = await db.execute(
        select(AccessPolicy)
        .where(AccessPolicy.is_active.is_(True))
        .where(or_(AccessPolicy.valid_from.is_(None), AccessPolicy.valid_from <= now))
        .where(or_(AccessPolicy.valid_until.is_(None), AccessPolicy.valid_until >= now))
        .where(or_(AccessPolicy.id.in_(by_user), AccessPolicy.id.in_(by_group)))
    )
    return list(result.scalars().all())


async def compute_grants(db: AsyncSession, user: User) -> dict[uuid.UUID, ServerGrant] | None:
    """Return {server_id: grant} for the user, or None meaning "everything" (admin)."""
    if user.role == UserRole.ADMIN:
        return None

    policies = await active_policies_for(db, user)
    if not policies:
        return {}

    needs_tree = any(p.nodes for p in policies)
    needs_labels = any(p.labels for p in policies)

    all_nodes: list[tuple[uuid.UUID, uuid.UUID | None]] = []
    if needs_tree:
        all_nodes = [(r[0], r[1]) for r in (await db.execute(select(Node.id, Node.parent_id))).all()]

    server_rows: list[tuple[uuid.UUID, uuid.UUID | None, dict | None]] = []
    if needs_tree or needs_labels:
        server_rows = [(r[0], r[1], r[2]) for r in (await db.execute(select(Server.id, Server.node_id, Server.tags))).all()]

    grants: dict[uuid.UUID, ServerGrant] = {}
    for policy in policies:
        targets: set[uuid.UUID] = {s.id for s in policy.servers}
        if policy.nodes:
            node_ids = node_descendants(all_nodes, {n.id for n in policy.nodes})
            targets |= {sid for sid, nid, _ in server_rows if nid in node_ids}
        if policy.labels:
            targets |= {sid for sid, _, tags in server_rows if _label_matches(tags, policy.labels)}

        actions = _role_ceiling(user, set(policy.actions or []))
        for sid in targets:
            g = grants.setdefault(sid, ServerGrant())
            g.actions |= actions
            g.accounts |= set(policy.accounts or [])
            g.policies.add(policy.name)
    return grants


def _sees_inventory(user: User) -> bool:
    from app.core.auth import has_perm
    return has_perm(user, "servers") or has_perm(user, "audit")


async def visible_server_ids(db: AsyncSession, user: User) -> set[uuid.UUID] | None:
    """Servers a user may list. Inventory / audit roles see all of them (without any action)."""
    if _sees_inventory(user):
        return None
    grants = await compute_grants(db, user)
    return None if grants is None else set(grants.keys())


async def get_grant(db: AsyncSession, user: User, server_id: uuid.UUID) -> ServerGrant | None:
    grants = await compute_grants(db, user)
    if grants is None:
        return ADMIN_GRANT
    return grants.get(server_id)


async def require_server(
    db: AsyncSession, user: User, server_id: uuid.UUID | str, action: str | None = None,
) -> tuple[Server, ServerGrant]:
    """Load a server the user may see; optionally require an action. 404 hides invisible servers."""
    sid = uuid.UUID(str(server_id))
    server = (await db.execute(select(Server).where(Server.id == sid))).scalar_one_or_none()
    grant = await get_grant(db, user, sid) if server else None
    if server and grant is None and _sees_inventory(user):
        grant = ServerGrant()  # visible for management / audit, no action on it
    if not server or grant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Server not found")
    if action and action not in grant.actions:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Action '{action}' not granted on this server",
        )
    return server, grant


# ── Account resolution ─────────────────────────────────


@dataclass
class ResolvedAccount:
    username: str
    password: bytes | None = None  # encrypted (AES-GCM), decrypted by the services
    ssh_key: bytes | None = None   # encrypted
    use_cert: bool = False
    cert_minutes: int | None = None
    label: str = ""                # for audit: "root", "@USER(jdoe)", "@INPUT(bob)"
    account_id: uuid.UUID | None = None


def user_login_name(user: User) -> str:
    """Username used by the @USER virtual account: local part of the UPN/email."""
    local = (user.email or "").split("@", 1)[0].strip().lower()
    if not local:
        raise HTTPException(status_code=400, detail="Cannot derive @USER username: user has no email")
    return local


def account_to_resolved(account: Account) -> ResolvedAccount:
    cred = account.credential
    use_cert = account.use_cert or (cred is not None and cred.type == CredentialType.EPHEMERAL_CERT)
    if not use_cert and cred is None:
        raise HTTPException(status_code=400, detail=f"Account '{account.username}' has no secret configured")
    return ResolvedAccount(
        username=account.username,
        password=None if use_cert else cred.encrypted_password,
        ssh_key=None if use_cert else cred.encrypted_ssh_key,
        use_cert=use_cert,
        cert_minutes=(cred.cert_validity_minutes if cred is not None else None),
        label=account.username,
        account_id=account.id,
    )


def default_account(server: Server) -> ResolvedAccount:
    """Automation account (monitoring, updates, commands). No user check."""
    acc = server.default_account
    if acc is None:
        raise HTTPException(status_code=400, detail="No default account configured on this server")
    return account_to_resolved(acc)


def resolve_for_user(
    server: Server,
    grant: ServerGrant,
    user: User,
    account_id: str | None = None,
    virtual: str | None = None,
    input_username: str | None = None,
    input_password: str | None = None,
) -> ResolvedAccount:
    """Pick the account a user connects with, enforcing the grant's account list."""
    if virtual == ACCOUNT_USER:
        if ACCOUNT_USER not in grant.accounts:
            raise HTTPException(status_code=403, detail="@USER account not granted")
        name = user_login_name(user)
        return ResolvedAccount(username=name, use_cert=True, label=f"@USER({name})")

    if virtual == ACCOUNT_INPUT:
        if ACCOUNT_INPUT not in grant.accounts:
            raise HTTPException(status_code=403, detail="@INPUT account not granted")
        if not input_username or not input_password:
            raise HTTPException(status_code=400, detail="Username and password required")
        return ResolvedAccount(
            username=input_username,
            password=encrypt_value(input_password),
            label=f"@INPUT({input_username})",
        )

    accounts = [a for a in server.accounts if a.is_active]
    if account_id:
        account = next((a for a in accounts if str(a.id) == str(account_id)), None)
        if account is None:
            raise HTTPException(status_code=404, detail="Account not found on this server")
    else:
        allowed = [a for a in accounts if grant.allows_account(a.username)]
        account = next((a for a in allowed if a.is_default), allowed[0] if allowed else None)
        if account is None:
            raise HTTPException(status_code=403, detail="No account granted on this server")

    if not grant.allows_account(account.username):
        raise HTTPException(status_code=403, detail=f"Account '{account.username}' not granted")
    return account_to_resolved(account)


def account_auth(account: Account) -> str:
    cred = account.credential
    if account.use_cert or (cred is not None and cred.type == CredentialType.EPHEMERAL_CERT):
        return "cert"
    if cred is None:
        return "none"
    return "ssh_key" if cred.encrypted_ssh_key else "password"


def connectable_accounts(server: Server, grant: ServerGrant) -> list[dict]:
    """Accounts (real and virtual) the user may pick for this server's protocol.

    Windows (RDP) only works with password accounts, so certificate / key
    accounts and @USER are not offered there.
    """
    windows = server.os_type == OSType.WINDOWS
    items = []
    for a in server.accounts:
        if not a.is_active or not grant.allows_account(a.username):
            continue
        auth = account_auth(a)
        if auth == "none" or (windows and auth != "password"):
            continue
        items.append({"id": str(a.id), "username": a.username, "privileged": a.privileged,
                      "is_default": a.is_default, "virtual": None, "auth": auth})
    if ACCOUNT_USER in grant.accounts and not windows:
        items.append({"id": None, "username": ACCOUNT_USER, "privileged": False,
                      "is_default": False, "virtual": ACCOUNT_USER, "auth": "cert"})
    if ACCOUNT_INPUT in grant.accounts:
        items.append({"id": None, "username": ACCOUNT_INPUT, "privileged": False,
                      "is_default": False, "virtual": ACCOUNT_INPUT, "auth": "password"})
    return items
