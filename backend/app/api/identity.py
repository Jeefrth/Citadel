"""Sign-in journal and devices (lot 6)."""

import csv
import io
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user, require_role
from app.core.database import get_db
from app.models.audit import AuditLog
from app.models.base import UserRole
from app.models.identity import LoginEvent, SSHConnectToken, UserDevice, UserSSHKey
from app.models.user import User
from app.services import devices
from app.services.reports import csv_safe

router = APIRouter()
admin_only = require_role(UserRole.ADMIN)


def _device_read(d: UserDevice, users: dict | None = None, current: str | None = None) -> dict:
    return {"id": str(d.id), "user_id": str(d.user_id), "user_name": (users or {}).get(d.user_id, ""),
            "kind": d.kind, "label": d.label, "ip_address": d.ip_address, "first_seen": d.first_seen,
            "last_seen": d.last_seen, "revoked_at": d.revoked_at, "revoked_by": d.revoked_by,
            "current": current == d.device_key}


def _current_key(request: Request, user: User) -> str:
    return devices.device_key_for(request, getattr(user, "_access_key_prefix", None))[0]


@router.get("/me/devices")
async def my_devices(request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    rows = (await db.execute(select(UserDevice).where(UserDevice.user_id == user.id)
                             .order_by(UserDevice.last_seen.desc()))).scalars().all()
    cur = _current_key(request, user)
    return [_device_read(d, current=cur) for d in rows]


@router.get("/devices")
async def all_devices(request: Request, user_id: uuid.UUID | None = None, active_only: bool = True,
                      db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    stmt = select(UserDevice).order_by(UserDevice.last_seen.desc()).limit(500)
    if user_id:
        stmt = stmt.where(UserDevice.user_id == user_id)
    if active_only:
        stmt = stmt.where(UserDevice.revoked_at.is_(None))
    rows = (await db.execute(stmt)).scalars().all()
    names = dict((await db.execute(select(User.id, User.display_name))).all())
    cur = _current_key(request, user)
    return [_device_read(d, names, cur if d.user_id == user.id else None) for d in rows]


async def _revoke(db: AsyncSession, dev: UserDevice | None, actor: User, request: Request) -> dict:
    if dev is None:
        raise HTTPException(status_code=404, detail="Device not found")
    if dev.revoked_at is None:
        await devices.revoke(db, dev, actor.display_name)
        db.add(AuditLog(user_id=actor.id, action="device.revoke", ip_address=getattr(request.state, "client_ip", None),
                        result=f"{dev.label} ({dev.kind}) de l'utilisateur {dev.user_id}"))
        await db.commit()
    return {"revoked": True}


@router.post("/me/devices/{device_id}/revoke")
async def revoke_my_device(device_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db),
                           user: User = Depends(get_current_user)):
    dev = await db.get(UserDevice, device_id)
    return await _revoke(db, dev if dev and dev.user_id == user.id else None, user, request)


@router.post("/devices/{device_id}/revoke")
async def revoke_device(device_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db),
                        user: User = Depends(admin_only)):
    return await _revoke(db, await db.get(UserDevice, device_id), user, request)


def _login_query(user_id, result, method, date_from, date_to):
    stmt = select(LoginEvent)
    if user_id:
        stmt = stmt.where(LoginEvent.user_id == user_id)
    if result:
        stmt = stmt.where(LoginEvent.result == result)
    if method:
        stmt = stmt.where(LoginEvent.method == method)
    if date_from:
        stmt = stmt.where(LoginEvent.created_at >= date_from)
    if date_to:
        stmt = stmt.where(LoginEvent.created_at <= date_to)
    return stmt


def _login_read(e: LoginEvent) -> dict:
    return {"id": str(e.id), "user_id": str(e.user_id) if e.user_id else None, "user_name": e.user_name,
            "method": e.method, "result": e.result, "reason": e.reason, "ip_address": e.ip_address,
            "device": devices.device_label(e.user_agent) if e.user_agent else None, "created_at": e.created_at}


@router.get("/login-events")
async def login_events(
    user_id: uuid.UUID | None = None, result: str | None = Query(default=None, pattern="^(success|denied)$"),
    method: str | None = None, date_from: datetime | None = None, date_to: datetime | None = None,
    limit: int = Query(default=100, ge=1, le=1000), offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
):
    """Admins: everyone. Others: their own sign-ins only."""
    if user.role != UserRole.ADMIN:
        user_id = user.id
    stmt = _login_query(user_id, result, method, date_from, date_to)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (await db.execute(stmt.order_by(LoginEvent.created_at.desc()).limit(limit).offset(offset))).scalars().all()
    return {"total": total, "items": [_login_read(e) for e in rows]}


@router.get("/login-events/export.csv")
async def export_login_events(
    user_id: uuid.UUID | None = None, result: str | None = Query(default=None, pattern="^(success|denied)$"),
    method: str | None = None, date_from: datetime | None = None, date_to: datetime | None = None,
    db: AsyncSession = Depends(get_db), _: User = Depends(admin_only),
):
    rows = (await db.execute(_login_query(user_id, result, method, date_from, date_to)
                             .order_by(LoginEvent.created_at.desc()).limit(100000))).scalars().all()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["date", "utilisateur", "methode", "resultat", "raison", "ip", "appareil"])
    for e in rows:
        r = _login_read(e)
        w.writerow([e.created_at.isoformat(), csv_safe(e.user_name), e.method, e.result, e.reason or "", e.ip_address or "",
                    r["device"] or ""])
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=citadel-connexions.csv"})


# ── SSH proxy: keys, connection tokens, connection info (lot 7) ──

class SSHKeyIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    public_key: str = Field(min_length=20, max_length=16000)


class TokenIn(BaseModel):
    minutes: int = Field(default=60, ge=1, le=1440)


def _key_read(k: UserSSHKey) -> dict:
    return {"id": str(k.id), "name": k.name, "fingerprint": k.fingerprint, "algorithm": k.public_key.split()[0],
            "created_at": k.created_at, "last_used_at": k.last_used_at}


@router.get("/me/ssh-proxy")
async def ssh_proxy_info(user: User = Depends(get_current_user)):
    from urllib.parse import urlparse
    from app.core.config import settings
    from app.services import ssh_proxy
    host = settings.SSH_PROXY_PUBLIC_HOST or urlparse(settings.PUBLIC_URL).hostname or "citadel"
    login = user.email or "?"
    return {"enabled": settings.SSH_PROXY_ENABLED, "host": host, "port": settings.SSH_PROXY_PORT,
            "login": login, "host_key_fingerprint": await ssh_proxy.host_fingerprint() if settings.SSH_PROXY_ENABLED else None,
            "example": f"ssh -p {settings.SSH_PROXY_PORT} '{login}'@{host}",
            "example_direct": f"ssh -p {settings.SSH_PROXY_PORT} '{login}#<serveur>'@{host}"}


@router.get("/me/ssh-keys")
async def list_ssh_keys(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    rows = (await db.execute(select(UserSSHKey).where(UserSSHKey.user_id == user.id)
                             .order_by(UserSSHKey.created_at))).scalars().all()
    return [_key_read(k) for k in rows]


@router.post("/me/ssh-keys", status_code=201)
async def add_ssh_key(data: SSHKeyIn, request: Request, db: AsyncSession = Depends(get_db),
                      user: User = Depends(get_current_user)):
    import asyncssh
    text = " ".join(data.public_key.strip().split())
    if "PRIVATE KEY" in text:
        raise HTTPException(status_code=400, detail="C'est une clé privée : collez la clé publique (fichier .pub)")
    try:
        key = asyncssh.import_public_key(text)
    except (asyncssh.KeyImportError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"Clé publique invalide : {e}")
    if key.algorithm == b"ssh-rsa" and key.pyca_key.key_size < 3072:
        raise HTTPException(status_code=400, detail="Clé RSA trop courte (3072 bits minimum) : préférez ed25519")
    fp = key.get_fingerprint("sha256")
    if (await db.execute(select(UserSSHKey.id).where(UserSSHKey.fingerprint == fp))).first():
        raise HTTPException(status_code=409, detail="Cette clé est déjà enregistrée")
    k = UserSSHKey(user_id=user.id, name=data.name, public_key=key.export_public_key().decode().strip(), fingerprint=fp)
    db.add(k)
    db.add(AuditLog(user_id=user.id, action="ssh_key.add", ip_address=getattr(request.state, "client_ip", None),
                    result=f"{data.name} {fp}"))
    await db.commit()
    return _key_read(k)


@router.delete("/me/ssh-keys/{key_id}", status_code=204)
async def delete_ssh_key(key_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db),
                         user: User = Depends(get_current_user)):
    k = await db.get(UserSSHKey, key_id)
    if not k or (k.user_id != user.id and user.role != UserRole.ADMIN):
        raise HTTPException(status_code=404, detail="Key not found")
    db.add(AuditLog(user_id=user.id, action="ssh_key.delete", ip_address=getattr(request.state, "client_ip", None),
                    result=f"{k.name} {k.fingerprint} (utilisateur {k.user_id})"))
    await db.delete(k)
    await db.commit()


@router.get("/ssh-keys")
async def all_ssh_keys(db: AsyncSession = Depends(get_db), _: User = Depends(admin_only)):
    names = dict((await db.execute(select(User.id, User.display_name))).all())
    rows = (await db.execute(select(UserSSHKey).order_by(UserSSHKey.created_at.desc()))).scalars().all()
    return [{**_key_read(k), "user_id": str(k.user_id), "user_name": names.get(k.user_id, "")} for k in rows]


@router.post("/me/ssh-tokens", status_code=201)
async def create_ssh_token(data: TokenIn, request: Request, db: AsyncSession = Depends(get_db),
                           user: User = Depends(get_current_user)):
    """A password for the SSH proxy, shown once. Several sessions may use it until it expires."""
    import secrets as _secrets
    from datetime import timedelta, timezone as _tz
    from app.services.ssh_proxy import hash_token
    if getattr(user, "_via_access_key", False):
        raise HTTPException(status_code=403, detail="Not allowed with an access key")
    token = _secrets.token_urlsafe(24)
    expires = datetime.now(_tz.utc) + timedelta(minutes=data.minutes)
    db.add(SSHConnectToken(user_id=user.id, token_hash=hash_token(token), expires_at=expires))
    db.add(AuditLog(user_id=user.id, action="ssh_token.create", ip_address=getattr(request.state, "client_ip", None),
                    result=f"{data.minutes} min"))
    await db.commit()
    return {"token": token, "expires_at": expires}


@router.get("/me/ssh-tokens")
async def list_ssh_tokens(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    from datetime import timezone as _tz
    now = datetime.now(_tz.utc)
    rows = (await db.execute(select(SSHConnectToken).where(
        SSHConnectToken.user_id == user.id, SSHConnectToken.revoked.is_(False), SSHConnectToken.expires_at > now)
        .order_by(SSHConnectToken.created_at.desc()))).scalars().all()
    return [{"id": str(t.id), "created_at": t.created_at, "expires_at": t.expires_at, "last_used_at": t.last_used_at}
            for t in rows]


@router.delete("/me/ssh-tokens/{token_id}", status_code=204)
async def revoke_ssh_token(token_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    t = await db.get(SSHConnectToken, token_id)
    if not t or t.user_id != user.id:
        raise HTTPException(status_code=404, detail="Token not found")
    t.revoked = True
    await db.commit()
