import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user, require_role
from app.core.database import get_db
from app.core.permissions import (
    ServerGrant, account_auth, compute_grants, connectable_accounts, node_descendants,
    require_server, resolve_for_user, ADMIN_GRANT,
)
from app.core.security import encrypt_value
from app.models.audit import AuditLog
from app.models.base import CredentialType, UserRole
from app.models.credential import Credential
from app.models.metric import ServerMetric
from app.models.pam import Account, Node, PolicyAction, UserFavorite
from app.models.server import Server
from app.models.update_job import UpdateJob
from app.models.user import User
from app.schemas.credential import CredentialCreate, CredentialRead, CredentialUpdate
from app.schemas.pam import AccountCreate, AccountRead, AccountUpdate
from app.schemas.server import (
    AccountSummary, ConnectableAccount, ConnectTicketRequest, ConnectTicketResponse,
    ServerCreate, ServerRead, ServerUpdate,
)
from app.services import tickets

router = APIRouter()


# ── Helpers ──────────────────────────────────────────────


def account_read(account: Account) -> AccountRead:
    from datetime import timedelta
    from app.services.secrets_ops import rotation_blocker
    blocker = rotation_blocker(account)
    nxt = None
    if account.rotation_enabled and not blocker:
        # Never rotated: due at the next scheduler pass
        nxt = (account.last_rotated_at + timedelta(days=account.rotation_interval_days)
               if account.last_rotated_at else account.created_at)
    return AccountRead(
        rotation_enabled=account.rotation_enabled,
        rotation_interval_days=account.rotation_interval_days,
        rotation_supported=blocker is None,
        rotation_blocker=blocker,
        last_rotated_at=account.last_rotated_at,
        next_rotation_at=nxt,
        last_rotation_status=account.last_rotation_status,
        last_rotation_message=account.last_rotation_message,
        verify_status=account.verify_status,
        verify_message=account.verify_message,
        last_verified_at=account.last_verified_at,
        id=account.id,
        server_id=account.server_id,
        username=account.username,
        credential_id=account.credential_id,
        credential_name=account.credential.name if account.credential else None,
        auth=account_auth(account),
        use_cert=account.use_cert,
        privileged=account.privileged,
        is_default=account.is_default,
        is_active=account.is_active,
        description=account.description,
        created_at=account.created_at,
    )


async def node_paths(db: AsyncSession) -> dict[uuid.UUID, str]:
    rows = (await db.execute(select(Node.id, Node.parent_id, Node.name))).all()
    by_id = {r[0]: (r[1], r[2]) for r in rows}
    cache: dict[uuid.UUID, str] = {}

    def path(nid: uuid.UUID, depth: int = 0) -> str:
        if nid in cache:
            return cache[nid]
        parent, name = by_id[nid]
        p = name if parent is None or parent not in by_id or depth > 50 else f"{path(parent, depth + 1)}/{name}"
        cache[nid] = p
        return p

    return {nid: path(nid) for nid in by_id}


def to_read(
    server: Server, grant: ServerGrant, favorites: set[uuid.UUID], paths: dict[uuid.UUID, str],
) -> ServerRead:
    default = server.default_account
    return ServerRead(
        id=server.id,
        name=server.name,
        hostname=server.hostname,
        ip_address=server.ip_address,
        os_type=server.os_type,
        os_version=server.os_version,
        ssh_port=server.ssh_port,
        winrm_port=server.winrm_port,
        rdp_port=server.rdp_port,
        status=server.status,
        last_seen=server.last_seen,
        tags=server.tags,
        node_id=server.node_id,
        node_path=paths.get(server.node_id) if server.node_id else None,
        created_at=server.created_at,
        default_account=AccountSummary(
            id=default.id, username=default.username, auth=account_auth(default),
            privileged=default.privileged, is_default=True,
        ) if default else None,
        accounts_count=len([a for a in server.accounts if a.is_active]),
        is_favorite=server.id in favorites,
        actions=sorted(grant.actions),
    )


async def user_favorites(db: AsyncSession, user: User) -> set[uuid.UUID]:
    rows = await db.execute(select(UserFavorite.server_id).where(UserFavorite.user_id == user.id))
    return {r[0] for r in rows.all()}


def parse_label_filters(labels: list[str]) -> list[tuple[str, str | None]]:
    out = []
    for raw in labels:
        key, sep, value = raw.partition("=")
        out.append((key.strip(), value if sep else None))
    return out


# ── Server listing / CRUD ────────────────────────────────


@router.get("/", response_model=list[ServerRead])
async def list_servers(
    node_id: uuid.UUID | None = Query(default=None, description="Filter by node"),
    recursive: bool = Query(default=True, description="Include servers of sub-nodes"),
    label: list[str] = Query(default=[], description="key=value (repeatable, all must match)"),
    q: str | None = Query(default=None, description="Search in name, hostname, IP"),
    favorites: bool = Query(default=False, description="Only my favourites"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    grants = await compute_grants(db, user)
    query = select(Server).order_by(Server.name)
    if grants is not None:
        if not grants:
            return []
        query = query.where(Server.id.in_(list(grants.keys())))

    if node_id:
        if recursive:
            nodes = [(r[0], r[1]) for r in (await db.execute(select(Node.id, Node.parent_id))).all()]
            ids = node_descendants(nodes, {node_id})
        else:
            ids = {node_id}
        query = query.where(Server.node_id.in_(list(ids)))

    if q:
        like = f"%{q.lower()}%"
        from sqlalchemy import func, or_
        query = query.where(or_(
            func.lower(Server.name).like(like),
            func.lower(Server.hostname).like(like),
            Server.ip_address.like(like),
        ))

    fav = await user_favorites(db, user)
    if favorites:
        if not fav:
            return []
        query = query.where(Server.id.in_(list(fav)))

    servers = (await db.execute(query)).scalars().all()

    for key, value in parse_label_filters(label):
        servers = [
            s for s in servers
            if s.tags and key in s.tags and (value is None or value == "" or str(s.tags[key]) == value)
        ]

    paths = await node_paths(db)
    return [to_read(s, ADMIN_GRANT if grants is None else grants[s.id], fav, paths) for s in servers]


@router.get("/labels/", response_model=dict[str, list[str]])
async def list_labels(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Distinct label keys and their values, among servers visible to the user (A2)."""
    grants = await compute_grants(db, user)
    query = select(Server.tags)
    if grants is not None:
        if not grants:
            return {}
        query = query.where(Server.id.in_(list(grants.keys())))
    out: dict[str, set[str]] = {}
    for (tags,) in (await db.execute(query)).all():
        for k, v in (tags or {}).items():
            out.setdefault(k, set()).add(str(v))
    return {k: sorted(v) for k, v in sorted(out.items())}


@router.post("/", response_model=ServerRead, status_code=status.HTTP_201_CREATED)
async def create_server(
    data: ServerCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    payload = data.model_dump(exclude={"default_account"})
    server = Server(**payload)
    db.add(server)
    await db.flush()

    if data.default_account:
        acc = data.default_account
        db.add(Account(
            server_id=server.id, username=acc.username, credential_id=acc.credential_id,
            use_cert=acc.use_cert, privileged=acc.privileged, is_default=True,
        ))

    db.add(AuditLog(user_id=user.id, server_id=server.id, action="server.create"))
    await db.commit()
    server = (await db.execute(select(Server).where(Server.id == server.id))).scalar_one()
    return to_read(server, ADMIN_GRANT, set(), await node_paths(db))


@router.get("/{server_id}", response_model=ServerRead)
async def get_server(
    server_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    server, grant = await require_server(db, user, server_id)
    return to_read(server, grant, await user_favorites(db, user), await node_paths(db))


@router.patch("/{server_id}", response_model=ServerRead)
async def update_server(
    server_id: uuid.UUID,
    data: ServerUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    server, grant = await require_server(db, user, server_id)
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(server, field, value)
    db.add(AuditLog(user_id=user.id, server_id=server.id, action="server.update"))
    await db.commit()
    await db.refresh(server)
    return to_read(server, grant, await user_favorites(db, user), await node_paths(db))


@router.delete("/{server_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_server(
    server_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    server, _ = await require_server(db, user, server_id)
    await db.execute(sa_delete(ServerMetric).where(ServerMetric.server_id == server_id))
    await db.execute(sa_delete(UpdateJob).where(UpdateJob.server_id == server_id))
    await db.execute(sa_delete(AuditLog).where(AuditLog.server_id == server_id))
    await db.delete(server)
    await db.commit()


# ── Favourites (A5) ─────────────────────────────────────


@router.put("/{server_id}/favorite", status_code=status.HTTP_204_NO_CONTENT)
async def add_favorite(
    server_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await require_server(db, user, server_id)
    exists = await db.get(UserFavorite, (user.id, server_id))
    if not exists:
        db.add(UserFavorite(user_id=user.id, server_id=server_id))
        await db.commit()


@router.delete("/{server_id}/favorite", status_code=status.HTTP_204_NO_CONTENT)
async def remove_favorite(
    server_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await db.execute(sa_delete(UserFavorite).where(
        UserFavorite.user_id == user.id, UserFavorite.server_id == server_id,
    ))
    await db.commit()


# ── Accounts (B1) ───────────────────────────────────────


@router.get("/{server_id}/accounts", response_model=list[AccountRead])
async def list_accounts(
    server_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    server, _ = await require_server(db, user, server_id)
    return [account_read(a) for a in server.accounts]


async def _clear_other_defaults(db: AsyncSession, server_id: uuid.UUID, keep: uuid.UUID | None):
    rows = (await db.execute(select(Account).where(Account.server_id == server_id, Account.is_default.is_(True)))).scalars()
    for a in rows:
        if a.id != keep:
            a.is_default = False


async def _check_credential(db: AsyncSession, credential_id: uuid.UUID | None):
    if credential_id and not await db.get(Credential, credential_id):
        raise HTTPException(status_code=400, detail="Credential not found")


@router.post("/{server_id}/accounts", response_model=AccountRead, status_code=status.HTTP_201_CREATED)
async def create_account(
    server_id: uuid.UUID,
    data: AccountCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    server, _ = await require_server(db, user, server_id)
    if any(a.username == data.username for a in server.accounts):
        raise HTTPException(status_code=409, detail="An account with this username already exists on this server")
    if not data.use_cert and not data.credential_id:
        raise HTTPException(status_code=400, detail="Choose a credential or the ephemeral certificate")
    await _check_credential(db, data.credential_id)

    account = Account(server_id=server.id, **data.model_dump())
    if not any(a.is_default for a in server.accounts):
        account.is_default = True
    db.add(account)
    await db.flush()
    if account.is_default:
        await _clear_other_defaults(db, server.id, account.id)
    account = (await db.execute(select(Account).where(Account.id == account.id))).scalar_one()
    if account.rotation_enabled:
        from app.services.secrets_ops import rotation_blocker
        blocker = rotation_blocker(account)
        if blocker:
            raise HTTPException(status_code=400, detail=blocker)
    db.add(AuditLog(user_id=user.id, server_id=server.id, action="account.create", result=data.username))
    await db.commit()
    return account_read(account)


@router.patch("/{server_id}/accounts/{account_id}", response_model=AccountRead)
async def update_account(
    server_id: uuid.UUID,
    account_id: uuid.UUID,
    data: AccountUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    account = (await db.execute(
        select(Account).where(Account.id == account_id, Account.server_id == server_id)
    )).scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    changes = data.model_dump(exclude_unset=True)
    if "credential_id" in changes:
        await _check_credential(db, changes["credential_id"])
    new_name = changes.get("username")
    if new_name and new_name != account.username:
        clash = (await db.execute(select(Account.id).where(
            Account.server_id == server_id, Account.username == new_name, Account.id != account_id,
        ))).first()
        if clash:
            raise HTTPException(status_code=409, detail="An account with this username already exists on this server")
    for field, value in changes.items():
        setattr(account, field, value)
    if changes.get("is_active") is False:
        account.is_default = False  # an inactive account cannot drive automation
    if "credential_id" in changes:
        await db.flush()
        await db.refresh(account, attribute_names=["credential"])
    if not account.use_cert and not account.credential_id:
        raise HTTPException(status_code=400, detail="Choose a credential or the ephemeral certificate")
    if changes.get("rotation_enabled"):
        from app.services.secrets_ops import rotation_blocker
        blocker = rotation_blocker(account)
        if blocker:
            raise HTTPException(status_code=400, detail=blocker)
    if "credential_id" in changes or "use_cert" in changes:
        account.verify_status = "unknown"  # secret changed: previous verification is stale
    if changes.get("is_default"):
        await _clear_other_defaults(db, server_id, account.id)
    db.add(AuditLog(user_id=user.id, server_id=server_id, action="account.update", result=account.username))
    await db.commit()
    account = (await db.execute(
        select(Account).where(Account.id == account_id).execution_options(populate_existing=True)
    )).scalar_one()
    return account_read(account)


@router.delete("/{server_id}/accounts/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(
    server_id: uuid.UUID,
    account_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    account = (await db.execute(
        select(Account).where(Account.id == account_id, Account.server_id == server_id)
    )).scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    db.add(AuditLog(user_id=user.id, server_id=server_id, action="account.delete", result=account.username))
    await db.delete(account)
    await db.commit()


# ── Connection (C1 + B9) ────────────────────────────────


@router.get("/{server_id}/connectable-accounts", response_model=list[ConnectableAccount])
async def list_connectable_accounts(
    server_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Accounts (real and virtual) the current user may use (needs connect or execute)."""
    server, grant = await require_server(db, user, server_id)
    if not grant.actions & {PolicyAction.CONNECT.value, PolicyAction.EXECUTE.value}:
        raise HTTPException(status_code=403, detail="Neither 'connect' nor 'execute' granted on this server")
    return connectable_accounts(server, grant)


@router.post("/{server_id}/connect-ticket", response_model=ConnectTicketResponse)
async def create_connect_ticket(
    server_id: uuid.UUID,
    body: ConnectTicketRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """One-time, 60 s ticket for the RDP WebSocket (no token/password in URLs)."""
    if body.protocol != "rdp":
        raise HTTPException(status_code=400, detail="Only 'rdp' tickets are supported")
    server, grant = await require_server(db, user, server_id, PolicyAction.CONNECT.value)
    account = resolve_for_user(
        server, grant, user,
        account_id=str(body.account_id) if body.account_id else None,
        virtual=body.virtual_account,
        input_username=body.input_username,
        input_password=body.input_password,
    )
    if account.use_cert or not account.password:
        raise HTTPException(status_code=400, detail="RDP requires a password account")
    ticket = await tickets.issue_ticket(
        user.id, server.id, "rdp", account,
        extra={
            "copy": PolicyAction.COPY.value in grant.actions,
            "paste": PolicyAction.PASTE.value in grant.actions,
        },
    )
    return ConnectTicketResponse(ticket=ticket, expires_in=tickets.TICKET_TTL_SECONDS, account=account.label)


# ── Credentials (encrypted secrets, referenced by accounts) ──


@router.get("/credentials/", response_model=list[CredentialRead])
async def list_credentials(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    result = await db.execute(select(Credential).order_by(Credential.name))
    return result.scalars().all()


@router.post("/credentials/", response_model=CredentialRead, status_code=status.HTTP_201_CREATED)
async def create_credential(
    data: CredentialCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    cred = Credential(
        name=data.name,
        type=data.type,
        username=data.username,
        encrypted_password=encrypt_value(data.password) if data.password else None,
        encrypted_ssh_key=encrypt_value(data.ssh_key) if data.ssh_key else None,
        cert_validity_minutes=data.cert_validity_minutes,
    )
    db.add(cred)
    db.add(AuditLog(user_id=user.id, action="credential.create"))
    await db.commit()
    await db.refresh(cred)
    return cred


@router.patch("/credentials/{cred_id}", response_model=CredentialRead)
async def update_credential(
    cred_id: uuid.UUID,
    data: CredentialUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    cred = await db.get(Credential, cred_id)
    if not cred:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Credential not found")
    if data.name is not None:
        cred.name = data.name
    if data.username is not None:
        cred.username = data.username
    if data.password is not None:
        cred.encrypted_password = encrypt_value(data.password)
    if data.ssh_key is not None:
        cred.encrypted_ssh_key = encrypt_value(data.ssh_key)
    if data.cert_validity_minutes is not None:
        cred.cert_validity_minutes = data.cert_validity_minutes
    db.add(AuditLog(user_id=user.id, action="credential.update"))
    await db.commit()
    await db.refresh(cred)
    return cred


@router.delete("/credentials/{cred_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_credential(
    cred_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    cred = await db.get(Credential, cred_id)
    if not cred:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Credential not found")
    used = (await db.execute(select(Account.id).where(Account.credential_id == cred_id).limit(1))).first()
    if used:
        raise HTTPException(status_code=409, detail="Credential is used by at least one account")
    db.add(AuditLog(user_id=user.id, action="credential.delete", result=cred.name))
    await db.delete(cred)
    await db.commit()
