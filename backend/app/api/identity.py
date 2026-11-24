"""Sign-in journal and devices (lot 6)."""

import csv
import io
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user, require_role
from app.core.database import get_db
from app.models.audit import AuditLog
from app.models.base import UserRole
from app.models.identity import LoginEvent, UserDevice
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
