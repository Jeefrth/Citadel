"""Secrets lifecycle API: account verification / rotation (B3, B6),
discovery (B5) and vault administration (B10)."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.servers import account_read
from app.core.auth import require_role
from app.core.database import get_db
from app.core.permissions import require_server
from app.models.audit import AuditLog
from app.models.base import UserRole
from app.models.credential import Credential
from app.models.pam import Account, DiscoveredAccount, SecretHistory
from app.models.server import Server
from app.models.user import User
from app.schemas.pam import (
    AccountRead, DiscoveredAccountRead, DiscoveredAccountUpdate, ManageDiscoveredAccount,
    OperationResult, SecretHistoryRead,
)
from app.services import secrets_admin, secrets_ops

router = APIRouter()
admin_only = require_role(UserRole.ADMIN)


async def _account(db: AsyncSession, server_id: uuid.UUID, account_id: uuid.UUID) -> Account:
    account = (await db.execute(
        select(Account).where(Account.id == account_id, Account.server_id == server_id)
    )).scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    return account


# ── Accounts: verify / rotate / history ──


@router.post("/servers/{server_id}/accounts/{account_id}/verify", response_model=OperationResult)
async def verify_account(server_id: uuid.UUID, account_id: uuid.UUID,
                         db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    account = await _account(db, server_id, account_id)
    res = await secrets_ops.verify_account(db, account)
    return OperationResult(ok=res.ok, message=res.message, account=account_read(account))


@router.post("/servers/{server_id}/accounts/{account_id}/rotate", response_model=OperationResult)
async def rotate_account(server_id: uuid.UUID, account_id: uuid.UUID,
                         db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    account = await _account(db, server_id, account_id)
    res = await secrets_ops.rotate_account(db, account, actor_id=user.id, reason="manual")
    account = (await db.execute(
        select(Account).where(Account.id == account_id).execution_options(populate_existing=True)
    )).scalar_one()
    return OperationResult(ok=res.ok, message=res.message, account=account_read(account))


@router.get("/servers/{server_id}/accounts/{account_id}/history", response_model=list[SecretHistoryRead])
async def account_history(server_id: uuid.UUID, account_id: uuid.UUID,
                          db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    """Rotation history (metadata only, never the secrets)."""
    await _account(db, server_id, account_id)
    rows = (await db.execute(
        select(SecretHistory).where(SecretHistory.account_id == account_id)
        .order_by(SecretHistory.created_at.desc())
    )).scalars().all()
    return rows


# ── Discovery ──


async def _discovered_read(db: AsyncSession, rows: list[DiscoveredAccount]) -> list[DiscoveredAccountRead]:
    server_ids = {r.server_id for r in rows}
    if not server_ids:
        return []
    names = dict((await db.execute(select(Server.id, Server.name).where(Server.id.in_(server_ids)))).all())
    managed = {(sid, u) for sid, u in (await db.execute(
        select(Account.server_id, Account.username).where(Account.server_id.in_(server_ids))
    )).all()}
    return [DiscoveredAccountRead(
        id=r.id, server_id=r.server_id, server_name=names.get(r.server_id), username=r.username,
        uid=r.uid, shell=r.shell, enabled=r.enabled, privileged=r.privileged, last_login=r.last_login,
        status=r.status, managed=(r.server_id, r.username) in managed,
        first_seen=r.first_seen, last_seen=r.last_seen,
    ) for r in rows]


@router.post("/servers/{server_id}/discover-accounts", response_model=OperationResult)
async def discover_server_accounts(server_id: uuid.UUID, db: AsyncSession = Depends(get_db),
                                   user: User = Depends(admin_only)):
    server, _ = await require_server(db, user, server_id)
    res = await secrets_ops.discover_accounts(db, server)
    db.add(AuditLog(user_id=user.id, server_id=server.id, action="account.discover",
                    status="success" if res.ok else "failure", result=res.message[:500]))
    await db.commit()
    return OperationResult(ok=res.ok, message=res.message)


@router.get("/discovered-accounts", response_model=list[DiscoveredAccountRead])
async def list_discovered(
    server_id: uuid.UUID | None = None,
    status: str | None = Query(default=None, pattern="^(new|ignored|gone)$"),
    unmanaged_only: bool = False,
    db: AsyncSession = Depends(get_db), user: User = Depends(admin_only),
):
    q = select(DiscoveredAccount).order_by(DiscoveredAccount.server_id, DiscoveredAccount.username)
    if server_id:
        q = q.where(DiscoveredAccount.server_id == server_id)
    if status:
        q = q.where(DiscoveredAccount.status == status)
    items = await _discovered_read(db, list((await db.execute(q)).scalars().all()))
    if unmanaged_only:
        items = [i for i in items if not i.managed]
    return items


@router.patch("/discovered-accounts/{item_id}", response_model=DiscoveredAccountRead)
async def update_discovered(item_id: uuid.UUID, data: DiscoveredAccountUpdate,
                            db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    row = await db.get(DiscoveredAccount, item_id)
    if not row:
        raise HTTPException(status_code=404, detail="Discovered account not found")
    row.status = data.status
    await db.commit()
    return (await _discovered_read(db, [row]))[0]


@router.post("/discovered-accounts/{item_id}/manage", response_model=AccountRead, status_code=201)
async def manage_discovered(item_id: uuid.UUID, data: ManageDiscoveredAccount,
                            db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    """Turn a discovered OS account into a managed Citadel account."""
    row = await db.get(DiscoveredAccount, item_id)
    if not row:
        raise HTTPException(status_code=404, detail="Discovered account not found")
    exists = (await db.execute(select(Account.id).where(
        Account.server_id == row.server_id, Account.username == row.username))).first()
    if exists:
        raise HTTPException(status_code=409, detail="This account is already managed")
    if not data.use_cert and not data.credential_id:
        raise HTTPException(status_code=400, detail="Choose a credential or the ephemeral certificate")
    if data.credential_id and not await db.get(Credential, data.credential_id):
        raise HTTPException(status_code=400, detail="Credential not found")
    account = Account(
        server_id=row.server_id, username=row.username, credential_id=data.credential_id,
        use_cert=data.use_cert, privileged=row.privileged if data.privileged is None else data.privileged,
        rotation_enabled=data.rotation_enabled,
    )
    db.add(account)
    await db.flush()
    account = (await db.execute(select(Account).where(Account.id == account.id))).scalar_one()
    if account.rotation_enabled and secrets_ops.rotation_blocker(account):
        raise HTTPException(status_code=400, detail=secrets_ops.rotation_blocker(account))
    db.add(AuditLog(user_id=user.id, server_id=row.server_id, action="account.create",
                    result=f"{row.username} (from discovery)"))
    await db.commit()
    return account_read(account)


# ── Vault administration ──


@router.get("/admin/secrets/status")
async def secrets_status(db: AsyncSession = Depends(get_db), _: User = Depends(admin_only)):
    return await secrets_admin.status(db)


@router.post("/admin/secrets/migrate")
async def secrets_migrate(db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    try:
        result = await secrets_admin.migrate(db)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    db.add(AuditLog(user_id=user.id, action="secrets.migrate", result=str(result)[:500]))
    await db.commit()
    return result


@router.post("/admin/secrets/rotate-key")
async def secrets_rotate_key(db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    try:
        result = await secrets_admin.rotate_key(db)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    db.add(AuditLog(user_id=user.id, action="secrets.rotate_key", result=str(result)[:500]))
    await db.commit()
    return result
