"""Application secrets API (lot 7).

Admins register an application and get a key once (cap_<prefix>_<secret>,
only its SHA-256 is stored). The application then reads secrets it is scoped
to, from allowed IPs only:

    GET /api/app/v1/secret?server=<name or id>&account=<username>
    Authorization: Bearer cap_...

Every read (and every refusal) is in the audit log (app.secret_read).
"""

import hashlib
import hmac
import ipaddress
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import require_role
from app.core.database import get_db
from app.core.governance import client_ip
from app.core.permissions import _label_matches, node_descendants
from app.core.security import decrypt_value
from app.models.audit import AuditLog
from app.models.base import UserRole
from app.models.pam import Application, Node
from app.models.server import Server
from app.models.user import User

router = APIRouter()
admin_only = require_role(UserRole.ADMIN)
PREFIX = "cap_"
bearer = HTTPBearer(auto_error=False)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class AppIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=500)
    is_active: bool = True
    expires_in_days: int | None = Field(default=365, ge=1, le=3650)
    allowed_ips: list[str] = Field(default_factory=list, max_length=50)
    server_ids: list[uuid.UUID] = Field(default_factory=list)
    node_ids: list[uuid.UUID] = Field(default_factory=list)
    labels: list[str] = Field(default_factory=list)
    accounts: list[str] = Field(min_length=1, max_length=100)

    @field_validator("allowed_ips")
    @classmethod
    def _cidrs(cls, v):
        for c in v:
            ipaddress.ip_network(c, strict=False)
        return v


def _read(a: Application) -> dict:
    return {"id": str(a.id), "name": a.name, "description": a.description, "key_prefix": a.key_prefix,
            "is_active": a.is_active, "expires_at": a.expires_at, "allowed_ips": a.allowed_ips or [],
            "server_ids": a.server_ids or [], "node_ids": a.node_ids or [], "labels": a.labels or [],
            "accounts": a.accounts or [], "last_used_at": a.last_used_at, "last_used_ip": a.last_used_ip,
            "created_at": a.created_at}


def _apply(a: Application, data: AppIn) -> None:
    a.name, a.description, a.is_active = data.name, data.description, data.is_active
    a.allowed_ips, a.labels, a.accounts = data.allowed_ips, data.labels, data.accounts
    a.server_ids = [str(x) for x in data.server_ids]
    a.node_ids = [str(x) for x in data.node_ids]
    if not (a.server_ids or a.node_ids or a.labels):
        raise HTTPException(status_code=400, detail="Choisir au moins un serveur, un nœud ou une étiquette")


@router.get("/applications")
async def list_apps(db: AsyncSession = Depends(get_db), _: User = Depends(admin_only)):
    return [_read(a) for a in (await db.execute(select(Application).order_by(Application.name))).scalars().all()]


@router.post("/applications", status_code=201)
async def create_app(data: AppIn, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    if (await db.execute(select(Application.id).where(Application.name == data.name))).first():
        raise HTTPException(status_code=409, detail="An application with this name already exists")
    prefix = secrets.token_hex(6)
    token = f"{PREFIX}{prefix}_{secrets.token_urlsafe(32)}"
    a = Application(key_prefix=prefix, key_hash=_hash(token), created_by=user.id,
                    expires_at=(datetime.now(timezone.utc) + timedelta(days=data.expires_in_days)) if data.expires_in_days else None)
    _apply(a, data)
    db.add(a)
    db.add(AuditLog(user_id=user.id, action="application.create", result=f"{data.name} ({prefix})"))
    await db.commit()
    return {**_read(a), "key": token}


@router.patch("/applications/{app_id}")
async def update_app(app_id: uuid.UUID, data: AppIn, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    a = await db.get(Application, app_id)
    if not a:
        raise HTTPException(status_code=404, detail="Application not found")
    _apply(a, data)
    db.add(AuditLog(user_id=user.id, action="application.update", result=a.name))
    await db.commit()
    return _read(a)


@router.post("/applications/{app_id}/rotate-key")
async def rotate_app_key(app_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    a = await db.get(Application, app_id)
    if not a:
        raise HTTPException(status_code=404, detail="Application not found")
    token = f"{PREFIX}{a.key_prefix}_{secrets.token_urlsafe(32)}"
    a.key_hash = _hash(token)
    db.add(AuditLog(user_id=user.id, action="application.rotate_key", result=a.name))
    await db.commit()
    return {**_read(a), "key": token}


@router.delete("/applications/{app_id}", status_code=204)
async def delete_app(app_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    a = await db.get(Application, app_id)
    if not a:
        raise HTTPException(status_code=404, detail="Application not found")
    db.add(AuditLog(user_id=user.id, action="application.delete", result=a.name))
    await db.delete(a)
    await db.commit()


# ── Secret retrieval (no user session: the application key) ──

def _ip_allowed(app: Application, ip: str | None) -> bool:
    if not app.allowed_ips:
        return True
    if not ip:
        return False
    addr = ipaddress.ip_address(ip)
    return any(addr in ipaddress.ip_network(c, strict=False) for c in app.allowed_ips)


async def _in_scope(db: AsyncSession, app: Application, server: Server) -> bool:
    if str(server.id) in (app.server_ids or []):
        return True
    if app.node_ids and server.node_id:
        pairs = [(r[0], r[1]) for r in (await db.execute(select(Node.id, Node.parent_id))).all()]
        if server.node_id in node_descendants(pairs, {uuid.UUID(n) for n in app.node_ids}):
            return True
    return bool(app.labels) and _label_matches(server.tags, app.labels)


@router.get("/app/v1/secret")
async def app_read_secret(request: Request, server: str, account: str,
                          creds: HTTPAuthorizationCredentials | None = Depends(bearer),
                          db: AsyncSession = Depends(get_db)):
    ip = client_ip(request.client.host if request.client else None, request.headers)
    token = creds.credentials if creds else ""
    parts = token.split("_", 2) if token.startswith(PREFIX) else []
    app = None
    org = None
    if len(parts) == 3:
        from app.core import tenancy
        from app.models.organization import Organization
        with tenancy.system():   # the key tells the organisation
            app = (await db.execute(select(Application).where(Application.key_prefix == parts[1]))).scalar_one_or_none()
            org = await db.get(Organization, app.org_id) if app is not None else None
    now = datetime.now(timezone.utc)
    if (app is None or org is None or not org.is_active or not hmac.compare_digest(app.key_hash, _hash(token))
            or not app.is_active or (app.expires_at and app.expires_at < now)):
        raise HTTPException(status_code=401, detail="Invalid application key")
    tenancy.set_context(tenancy.TenantContext.for_org(org))
    await tenancy.apply_to_session(db)

    from app.services.secrets_ops import _system_user_id
    actor = app.created_by or await _system_user_id(db)

    async def deny(reason: str, code: int = 403):
        db.add(AuditLog(user_id=actor, action="app.secret_read", status="failure", ip_address=ip,
                        result=f"{app.name}: {server}/{account} refusé ({reason})"[:500]))
        await db.commit()
        raise HTTPException(status_code=code, detail=reason)

    if not _ip_allowed(app, ip):
        await deny("source IP not allowed")
    try:
        srv = await db.get(Server, uuid.UUID(server))
    except ValueError:
        matches = (await db.execute(select(Server).where(func.lower(Server.name) == server.lower()))).scalars().all()
        srv = matches[0] if len(matches) == 1 else None
        if len(matches) > 1:
            await deny("several servers have this name: use the server id", 409)
    if srv is None or not await _in_scope(db, app, srv):
        await deny("server not found or not in scope", 404)
    if "*" not in (app.accounts or []) and account not in (app.accounts or []):
        await deny("account not in scope")
    acc = next((a for a in srv.accounts if a.username == account and a.is_active), None)
    if acc is None or acc.use_cert or acc.credential is None:
        await deny("account not found or has no stored secret", 404)
    cred = acc.credential
    out = {"server": srv.name, "server_id": str(srv.id), "address": srv.ip_address, "os": srv.os_type.value,
           "port": srv.ssh_port if srv.os_type.value == "linux" else srv.winrm_port, "username": acc.username,
           "type": cred.type.value}
    if cred.encrypted_password:
        out["password"] = decrypt_value(cred.encrypted_password)
    if cred.encrypted_ssh_key:
        out["private_key"] = decrypt_value(cred.encrypted_ssh_key)
    app.last_used_at, app.last_used_ip = now, ip
    db.add(AuditLog(user_id=actor, server_id=srv.id, action="app.secret_read", ip_address=ip,
                    result=f"{app.name}: {srv.name}/{acc.username}"))
    await db.commit()
    return out
