"""Audit API (lot 4): live sessions (D4/D5), command journal (D3),
recording storage (D8) and SIEM targets (D9)."""

import csv
import io
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user, require_role
from app.core.database import get_db
from app.core.security import encrypt_value
from app.models.audit import AuditLog
from app.models.audit_trail import CommandLog, RecordingStorage, SiemTarget
from app.models.base import UserRole
from app.models.user import User
from app.services import live, recording_storage, siem, tickets
from app.services.notifications import notify

router = APIRouter()
admin_only = require_role(UserRole.ADMIN)


# ── Live sessions (D4 / D5) ─────────────────────────────


@router.get("/live-sessions")
async def list_live_sessions(_: User = Depends(admin_only)):
    return await live.list_active()


class KillIn(BaseModel):
    reason: str | None = Field(default=None, max_length=500)


@router.post("/live-sessions/{session_id}/kill")
async def kill_session(session_id: str, data: KillIn, request: Request,
                       db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    meta = await live.get(session_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Session not found or already closed")
    delivered = await live.send_control(session_id, {"action": "kill", "by": user.display_name, "reason": data.reason})
    db.add(AuditLog(user_id=user.id, server_id=meta.get("server_id"), action="session.kill",
                    ip_address=getattr(request.state, "client_ip", None),
                    result=f"{session_id} user={meta.get('user')} reason={data.reason or '-'}"))
    if meta.get("user_id"):
        await notify(db, "session.killed", f"Votre session sur {meta.get('server')} a été terminée",
                     f"Par {user.display_name}" + (f" : {data.reason}" if data.reason else ""),
                     recipients=[uuid.UUID(meta["user_id"])], level="warning")
    await db.commit()
    return {"delivered": delivered > 0}


@router.post("/live-sessions/{session_id}/monitor-ticket")
async def monitor_ticket(session_id: str, request: Request, db: AsyncSession = Depends(get_db),
                         user: User = Depends(admin_only)):
    """One-time ticket to watch an RDP session read-only (/ws/monitor-rdp)."""
    meta = await live.get(session_id)
    if not meta or meta.get("protocol") != "rdp":
        raise HTTPException(status_code=404, detail="RDP session not found")
    db.add(AuditLog(user_id=user.id, server_id=meta.get("server_id"), action="session.monitor",
                    ip_address=getattr(request.state, "client_ip", None),
                    result=f"{session_id} user={meta.get('user')} account={meta.get('account')}"))
    await db.commit()
    ticket = await tickets.issue_raw({"kind": "monitor-rdp", "session_id": session_id, "watcher": user.display_name})
    return {"ticket": ticket, "expires_in": tickets.TICKET_TTL_SECONDS,
            "width": meta.get("width"), "height": meta.get("height")}


# ── Command journal (D3) ────────────────────────────────


def _command_query(user: User, q, user_id, server_id, decision, source, session_id, date_from, date_to):
    stmt = select(CommandLog)
    if user.role != UserRole.ADMIN:
        stmt = stmt.where(CommandLog.user_id == user.id)  # users only see their own commands
    elif user_id:
        stmt = stmt.where(CommandLog.user_id == user_id)
    if q:
        stmt = stmt.where(CommandLog.command.ilike(f"%{q}%"))  # pg_trgm index
    if server_id:
        stmt = stmt.where(CommandLog.server_id == server_id)
    if decision:
        stmt = stmt.where(CommandLog.decision == decision)
    if source:
        stmt = stmt.where(CommandLog.source == source)
    if session_id:
        stmt = stmt.where(CommandLog.session_id == session_id)
    if date_from:
        stmt = stmt.where(CommandLog.created_at >= date_from)
    if date_to:
        stmt = stmt.where(CommandLog.created_at <= date_to)
    return stmt


def _cmd_dict(c: CommandLog) -> dict:
    return {
        "id": str(c.id), "session_id": c.session_id, "user_id": str(c.user_id), "user_name": c.user_name,
        "server_id": str(c.server_id) if c.server_id else None, "server_name": c.server_name,
        "account": c.account, "command": c.command, "source": c.source, "decision": c.decision,
        "rule": c.rule, "exit_code": c.exit_code, "offset_ms": c.offset_ms, "ip_address": c.ip_address,
        "created_at": c.created_at.isoformat(),
    }


@router.get("/command-logs")
async def search_commands(
    q: str | None = None, user_id: uuid.UUID | None = None, server_id: uuid.UUID | None = None,
    decision: str | None = None, source: str | None = None, session_id: str | None = None,
    date_from: datetime | None = None, date_to: datetime | None = None,
    limit: int = Query(default=100, ge=1, le=1000), offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
):
    stmt = _command_query(user, q, user_id, server_id, decision, source, session_id, date_from, date_to)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (await db.execute(stmt.order_by(CommandLog.created_at.desc()).limit(limit).offset(offset))).scalars().all()
    return {"total": total, "items": [_cmd_dict(c) for c in rows]}


@router.get("/command-logs/export.csv")
async def export_commands(
    q: str | None = None, user_id: uuid.UUID | None = None, server_id: uuid.UUID | None = None,
    decision: str | None = None, source: str | None = None,
    date_from: datetime | None = None, date_to: datetime | None = None,
    db: AsyncSession = Depends(get_db), user: User = Depends(admin_only),
):
    stmt = _command_query(user, q, user_id, server_id, decision, source, None, date_from, date_to)
    rows = (await db.execute(stmt.order_by(CommandLog.created_at.desc()).limit(100000))).scalars().all()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["date", "utilisateur", "serveur", "compte", "source", "decision", "regle", "code_retour", "ip", "commande"])
    for c in rows:
        # Neutralise spreadsheet formulas (CSV injection)
        cmd = ("'" + c.command) if c.command[:1] in ("=", "+", "-", "@") else c.command
        w.writerow([c.created_at.isoformat(), c.user_name, c.server_name, c.account or "", c.source,
                    c.decision, c.rule or "", "" if c.exit_code is None else c.exit_code, c.ip_address or "", cmd])
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=citadel-commandes.csv"})


# ── Recording storage (D8) ──────────────────────────────


class StorageIn(BaseModel):
    type: str = Field(pattern="^(local|s3|azure)$")
    config: dict = Field(default_factory=dict)
    secret: str | None = None  # S3 secret key / Azure SAS token; omitted = unchanged


def _storage_read(row: RecordingStorage | None) -> dict:
    if row is None:
        return {"type": "local", "config": {}, "has_secret": False, "last_error": None}
    return {"type": row.type, "config": row.config or {}, "has_secret": bool(row.encrypted_secret),
            "last_error": row.last_error}


async def _active_storage(db: AsyncSession) -> RecordingStorage | None:
    return (await db.execute(select(RecordingStorage).where(RecordingStorage.is_active.is_(True)).limit(1))).scalar_one_or_none()


@router.get("/admin/recording-storage")
async def get_storage(db: AsyncSession = Depends(get_db), _: User = Depends(admin_only)):
    return _storage_read(await _active_storage(db))


@router.put("/admin/recording-storage")
async def set_storage(data: StorageIn, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    if data.type == "s3" and not (data.config.get("bucket") and data.config.get("access_key")):
        raise HTTPException(status_code=400, detail="S3 needs a bucket and an access key")
    if data.type == "azure" and not str(data.config.get("container_url", "")).startswith("https://"):
        raise HTTPException(status_code=400, detail="Azure needs an https container URL")
    current = await _active_storage(db)
    # Keep previous rows (inactive): old recordings must stay readable
    same = (await db.execute(select(RecordingStorage).where(RecordingStorage.type == data.type)
                             .order_by(RecordingStorage.created_at.desc()).limit(1))).scalar_one_or_none()
    if current and current is not same:
        current.is_active = False
    row = same or RecordingStorage(type=data.type)
    row.config, row.is_active = data.config, True
    if data.secret:
        row.encrypted_secret = encrypt_value(data.secret)
    if data.type in ("s3", "azure") and not row.encrypted_secret:
        raise HTTPException(status_code=400, detail="Secret (S3 secret key or Azure SAS token) is required")
    db.add(row)
    db.add(AuditLog(user_id=user.id, action="recording_storage.update", result=data.type))
    await db.commit()
    return _storage_read(row)


@router.post("/admin/recording-storage/test")
async def test_storage(db: AsyncSession = Depends(get_db), _: User = Depends(admin_only)):
    row = await _active_storage(db)
    backend = recording_storage.backend_from(row)
    key = f"_citadel_probe/{uuid.uuid4()}.txt"
    try:
        await backend.put(key, b"citadel storage probe")
        ok = await backend.get(key) == b"citadel storage probe"
        await backend.delete(key)
        message = "Écriture, lecture et suppression OK" if ok else "Contenu relu différent"
        if row:
            row.last_error = None if ok else message
    except Exception as e:  # noqa: BLE001
        ok, message = False, f"{type(e).__name__}: {e}"[:500]
        if row:
            row.last_error = message
    await db.commit()
    return {"ok": ok, "message": message, "type": backend.type}


# ── SIEM targets (D9) ───────────────────────────────────


class SiemIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    is_active: bool = True
    transport: str = Field(pattern="^(udp|tcp|tls|http)$")
    format: str = Field(pattern="^(json|cef|hec)$")
    config: dict = Field(default_factory=dict)
    secret: str | None = None
    streams: list[str] = Field(default_factory=lambda: ["audit", "commands"])
    start_from: str = Field(default="now", pattern="^(now|beginning)$")  # creation only


class SiemUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    is_active: bool | None = None
    transport: str | None = Field(default=None, pattern="^(udp|tcp|tls|http)$")
    format: str | None = Field(default=None, pattern="^(json|cef|hec)$")
    config: dict | None = None
    secret: str | None = None
    streams: list[str] | None = None


def _siem_read(t: SiemTarget) -> dict:
    return {"id": str(t.id), "name": t.name, "is_active": t.is_active, "transport": t.transport,
            "format": t.format, "config": t.config or {}, "has_secret": bool(t.encrypted_secret),
            "streams": t.streams or [], "cursors": t.cursors or {}, "sent_count": t.sent_count,
            "last_sent_at": t.last_sent_at, "last_error": t.last_error, "created_at": t.created_at}


def _check_siem(transport: str, fmt: str, config: dict, streams: list[str]) -> None:
    if set(streams) - {"audit", "commands"} or not streams:
        raise HTTPException(status_code=400, detail="streams must be a non-empty subset of audit, commands")
    if transport == "http":
        if not str(config.get("url", "")).startswith(("https://", "http://")):
            raise HTTPException(status_code=400, detail="HTTP transport needs a URL")
    else:
        if not config.get("host"):
            raise HTTPException(status_code=400, detail="Syslog transport needs a host")
        if fmt == "hec":
            raise HTTPException(status_code=400, detail="HEC format is only available over HTTP")


async def _now_cursors(db: AsyncSession) -> dict:
    out = {}
    a = (await db.execute(select(AuditLog.timestamp, AuditLog.id).order_by(AuditLog.timestamp.desc(), AuditLog.id.desc()).limit(1))).first()
    if a:
        out["audit"] = {"ts": a[0].isoformat(), "id": str(a[1])}
    c = (await db.execute(select(CommandLog.created_at, CommandLog.id).order_by(CommandLog.created_at.desc(), CommandLog.id.desc()).limit(1))).first()
    if c:
        out["commands"] = {"ts": c[0].isoformat(), "id": str(c[1])}
    return out


@router.get("/siem-targets")
async def list_siem(db: AsyncSession = Depends(get_db), _: User = Depends(admin_only)):
    rows = (await db.execute(select(SiemTarget).order_by(SiemTarget.name))).scalars().all()
    return [_siem_read(t) for t in rows]


@router.post("/siem-targets", status_code=201)
async def create_siem(data: SiemIn, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    _check_siem(data.transport, data.format, data.config, data.streams)
    if (await db.execute(select(SiemTarget.id).where(SiemTarget.name == data.name))).first():
        raise HTTPException(status_code=409, detail="A target with this name already exists")
    t = SiemTarget(name=data.name, is_active=data.is_active, transport=data.transport, format=data.format,
                   config=data.config, streams=data.streams,
                   encrypted_secret=encrypt_value(data.secret) if data.secret else None,
                   cursors=await _now_cursors(db) if data.start_from == "now" else {})
    db.add(t)
    db.add(AuditLog(user_id=user.id, action="siem_target.create", result=data.name))
    await db.commit()
    return _siem_read(t)


@router.patch("/siem-targets/{target_id}")
async def update_siem(target_id: uuid.UUID, data: SiemUpdate, db: AsyncSession = Depends(get_db),
                      user: User = Depends(admin_only)):
    t = await db.get(SiemTarget, target_id)
    if not t:
        raise HTTPException(status_code=404, detail="Target not found")
    changes = data.model_dump(exclude_unset=True)
    secret = changes.pop("secret", None)
    merged = {"transport": t.transport, "format": t.format, "config": t.config, "streams": t.streams, **changes}
    _check_siem(merged["transport"], merged["format"], merged["config"] or {}, merged["streams"] or [])
    for k, v in changes.items():
        setattr(t, k, v)
    if secret:
        t.encrypted_secret = encrypt_value(secret)
    db.add(AuditLog(user_id=user.id, action="siem_target.update", result=t.name))
    await db.commit()
    return _siem_read(t)


@router.delete("/siem-targets/{target_id}", status_code=204)
async def delete_siem(target_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    t = await db.get(SiemTarget, target_id)
    if not t:
        raise HTTPException(status_code=404, detail="Target not found")
    db.add(AuditLog(user_id=user.id, action="siem_target.delete", result=t.name))
    await db.delete(t)
    await db.commit()


@router.post("/siem-targets/{target_id}/test")
async def test_siem(target_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    t = await db.get(SiemTarget, target_id)
    if not t:
        raise HTTPException(status_code=404, detail="Target not found")
    event = {"stream": "audit", "id": str(uuid.uuid4()), "timestamp": datetime.now(timezone.utc).isoformat(),
             "action": "siem.test", "status": "success", "user_id": str(user.id), "user": user.display_name,
             "server_id": None, "server": None, "command": None, "result": f"Test event for target {t.name}",
             "src_ip": None}
    try:
        await siem.send(t, [event])
        t.last_error = None
        ok, message = True, "Événement de test envoyé"
    except Exception as e:  # noqa: BLE001
        t.last_error = f"{type(e).__name__}: {e}"[:500]
        ok, message = False, t.last_error
    await db.commit()
    return {"ok": ok, "message": message}


class CursorIn(BaseModel):
    position: str = Field(pattern="^(now|beginning)$")


@router.post("/siem-targets/{target_id}/cursor")
async def reset_cursor(target_id: uuid.UUID, data: CursorIn, db: AsyncSession = Depends(get_db),
                       user: User = Depends(admin_only)):
    """'now' skips the backlog, 'beginning' re-sends everything."""
    t = await db.get(SiemTarget, target_id)
    if not t:
        raise HTTPException(status_code=404, detail="Target not found")
    t.cursors = await _now_cursors(db) if data.position == "now" else {}
    db.add(AuditLog(user_id=user.id, action="siem_target.cursor", result=f"{t.name}: {data.position}"))
    await db.commit()
    return _siem_read(t)
