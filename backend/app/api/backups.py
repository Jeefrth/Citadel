"""Encrypted account backups (lot 7). Admins only; a download is a secret export."""

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import require_role
from app.core.database import get_db
from app.models.audit import AuditLog
from app.models.base import UserRole
from app.models.pam import AccountBackup
from app.models.user import User
from app.services import account_backup

router = APIRouter()
admin_only = require_role(UserRole.ADMIN)


def _read(b: AccountBackup) -> dict:
    return {"id": str(b.id), "created_at": b.created_at, "trigger": b.trigger, "destinations": b.destinations,
            "status": b.status, "message": b.message, "accounts": b.accounts, "size_bytes": b.size_bytes,
            "sha256": b.sha256, "storage_type": b.storage_type, "storage_key": b.storage_key}


@router.get("/admin/backups")
async def backup_status(db: AsyncSession = Depends(get_db), _: User = Depends(admin_only)):
    rows = (await db.execute(select(AccountBackup).order_by(AccountBackup.created_at.desc()).limit(50))).scalars().all()
    return {"has_passphrase": bool(await account_backup.get_passphrase(db)), "history": [_read(b) for b in rows]}


class PassphraseIn(BaseModel):
    passphrase: str = Field(min_length=account_backup.MIN_PASSPHRASE, max_length=500)


@router.put("/admin/backups/passphrase")
async def set_passphrase(data: PassphraseIn, request: Request, db: AsyncSession = Depends(get_db),
                         user: User = Depends(admin_only)):
    if getattr(user, "_via_access_key", False):
        raise HTTPException(status_code=403, detail="Not allowed with an access key")
    try:
        await account_backup.set_passphrase(db, data.passphrase)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    db.add(AuditLog(user_id=user.id, action="accounts.backup_passphrase", ip_address=getattr(request.state, "client_ip", None),
                    result="phrase de passe des sauvegardes changée"))
    await db.commit()
    return {"has_passphrase": True}


class RunIn(BaseModel):
    destinations: list[str] = Field(default_factory=lambda: ["download"], min_length=1)
    recipients: list[str] = Field(default_factory=list, max_length=20)


@router.post("/admin/backups/run")
async def run_backup(data: RunIn, request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    """With "download" in destinations, the encrypted archive is the response body."""
    if any(d not in ("download", "storage", "email") for d in data.destinations):
        raise HTTPException(status_code=400, detail="destinations: download, storage, email")
    if "download" in data.destinations and getattr(user, "_via_access_key", False):
        raise HTTPException(status_code=403, detail="Download not allowed with an access key")
    row, blob = await account_backup.run_backup(db, trigger="manual", destinations=data.destinations,
                                                actor_id=user.id, recipients=data.recipients)
    if row.status == "failed" or ("download" in data.destinations and blob is None):
        raise HTTPException(status_code=400, detail=row.message or "Backup failed")
    if "download" in data.destinations:
        return Response(content=blob, media_type="application/octet-stream", headers={
            "Content-Disposition": f"attachment; filename=citadel-comptes-{row.created_at:%Y%m%d-%H%M%S}.cab",
            "Cache-Control": "no-store", "X-Backup-Status": row.status, "X-Backup-Sha256": row.sha256 or ""})
    return _read(row)
