"""Session recordings: list, replay (SSH events / RDP guac dump), integrity, deletion."""

import csv
import io
import json
import tempfile
import uuid
import zipfile

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user, require_role, has_perm, require_perm
from app.core.database import get_db
from app.models.audit import AuditLog
from app.models.base import UserRole
from app.models.session_recording import SessionRecording
from app.models.user import User
from app.schemas.session import SessionRecordingDetail, SessionRecordingList
from app.services import recording_storage

router = APIRouter()


@router.get("/", response_model=list[SessionRecordingList])
async def list_sessions(
    server_id: uuid.UUID | None = Query(default=None),
    protocol: str | None = Query(default=None, pattern="^(ssh|rdp|k8s)$"),
    session_id: str | None = Query(default=None, description="Exact session id (command journal deep links)"),
    limit: int = Query(default=50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List recorded sessions (admins: all, others: their own)."""
    query = select(SessionRecording).order_by(SessionRecording.started_at.desc())
    if not has_perm(user, "audit"):
        query = query.where(SessionRecording.user_id == user.id)
    if server_id:
        query = query.where(SessionRecording.server_id == server_id)
    if protocol:
        query = query.where(SessionRecording.protocol == protocol)
    if session_id:
        query = query.where(SessionRecording.session_id == session_id)
    return (await db.execute(query.limit(limit))).scalars().all()


async def _get_visible(db: AsyncSession, user: User, recording_id: uuid.UUID) -> SessionRecording:
    rec = (await db.execute(select(SessionRecording).where(SessionRecording.id == recording_id))).scalar_one_or_none()
    if not rec or (not has_perm(user, "audit") and rec.user_id != user.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recording not found")
    return rec


async def _load(db: AsyncSession, rec: SessionRecording) -> bytes:
    if not rec.storage_key:
        raise HTTPException(status_code=404, detail="Recording content not available (session still running or never stored)")
    try:
        return await recording_storage.load(db, rec.storage_type, rec.storage_key, rec.sha256)
    except recording_storage.IntegrityError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except recording_storage.StorageError as e:
        raise HTTPException(status_code=502, detail=str(e))


async def _audit_view(db: AsyncSession, user: User, rec: SessionRecording, request: Request) -> None:
    db.add(AuditLog(user_id=user.id, server_id=rec.server_id, action="recording.view",
                    ip_address=getattr(request.state, "client_ip", None),
                    result=f"{rec.session_id} ({rec.protocol}, {rec.user_name})"))
    await db.commit()


@router.get("/{recording_id}", response_model=SessionRecordingDetail)
async def get_session(recording_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db),
                      user: User = Depends(get_current_user)):
    """SSH recording with its events for replay."""
    rec = await _get_visible(db, user, recording_id)
    if rec.protocol not in ("ssh", "k8s"):
        raise HTTPException(status_code=400, detail="Not an SSH recording: use /rdp")
    events = rec.events if rec.events is not None else json.loads(await _load(db, rec))
    await _audit_view(db, user, rec, request)
    data = SessionRecordingList.model_validate(rec).model_dump()
    return SessionRecordingDetail(**data, events=events)


@router.get("/{recording_id}/rdp")
async def get_rdp_recording(recording_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db),
                            user: User = Depends(get_current_user)):
    """Raw Guacamole protocol dump, replayed client-side with Guacamole.SessionRecording."""
    rec = await _get_visible(db, user, recording_id)
    if rec.protocol != "rdp":
        raise HTTPException(status_code=400, detail="Not an RDP recording")
    content = await _load(db, rec)
    await _audit_view(db, user, rec, request)
    return Response(content=content, media_type="application/octet-stream",
                    headers={"Cache-Control": "no-store"})


@router.get("/{recording_id}/verify")
async def verify_recording(recording_id: uuid.UUID, db: AsyncSession = Depends(get_db),
                           user: User = Depends(require_perm("audit"))):
    """Re-read the stored object and check its SHA-256."""
    rec = await _get_visible(db, user, recording_id)
    if not rec.storage_key:
        return {"ok": rec.events is not None, "message": "Ancien enregistrement stocké en base (sans empreinte)",
                "storage": "database"}
    try:
        await recording_storage.load(db, rec.storage_type, rec.storage_key, rec.sha256)
        return {"ok": True, "message": f"Intègre (SHA-256 {rec.sha256[:16]}…)", "storage": rec.storage_type}
    except recording_storage.IntegrityError as e:
        return {"ok": False, "message": str(e), "storage": rec.storage_type}
    except recording_storage.StorageError as e:
        return {"ok": False, "message": f"Illisible : {e}", "storage": rec.storage_type}


async def _delete(db: AsyncSession, recs: list[SessionRecording], user: User, reason: str) -> int:
    for rec in recs:
        if rec.storage_key:
            await recording_storage.remove(db, rec.storage_type, rec.storage_key)
        db.add(AuditLog(user_id=user.id, server_id=rec.server_id, action="recording.delete",
                        result=f"{rec.session_id} ({rec.protocol}, {rec.user_name}) {reason}"))
        await db.delete(rec)
    await db.commit()
    return len(recs)


@router.delete("/{recording_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(recording_id: uuid.UUID, db: AsyncSession = Depends(get_db),
                         user: User = Depends(require_role(UserRole.ADMIN))):
    rec = await _get_visible(db, user, recording_id)
    await _delete(db, [rec], user, "manual")


class BulkDeleteRequest(BaseModel):
    ids: list[uuid.UUID]


@router.post("/bulk-delete", status_code=status.HTTP_200_OK)
async def bulk_delete_sessions(body: BulkDeleteRequest, db: AsyncSession = Depends(get_db),
                               user: User = Depends(require_role(UserRole.ADMIN))):
    recs = (await db.execute(select(SessionRecording).where(SessionRecording.id.in_(body.ids)))).scalars().all()
    return {"deleted": await _delete(db, list(recs), user, "bulk")}


@router.post("/delete-all", status_code=status.HTTP_200_OK)
async def delete_all_sessions(db: AsyncSession = Depends(get_db),
                              user: User = Depends(require_role(UserRole.ADMIN))):
    recs = (await db.execute(select(SessionRecording).where(SessionRecording.ended_at.is_not(None)))).scalars().all()
    return {"deleted": await _delete(db, list(recs), user, "delete-all")}


class BulkDownloadRequest(BaseModel):
    ids: list[uuid.UUID] = Field(min_length=1, max_length=200)


def to_asciicast(events: list[dict], rec: SessionRecording) -> str:
    """asciinema v2 (.cast): plays with `asciinema play` or any asciinema player."""
    import base64
    header = {"version": 2, "width": 120, "height": 32,
              "timestamp": int(rec.started_at.timestamp()) if rec.started_at else 0,
              "title": f"{rec.user_name} @ {rec.server_name} ({rec.account or ''})"}
    lines = [json.dumps(header, ensure_ascii=False)]
    for ev in events:
        kind = ev.get("type")
        if kind not in ("o", "i"):
            continue
        text = base64.b64decode(ev.get("data", "")).decode("utf-8", errors="replace")
        lines.append(json.dumps([round(ev.get("t", 0) / 1000, 3), kind, text], ensure_ascii=False))
    return "\n".join(lines) + "\n"


@router.post("/bulk-download")
async def bulk_download(body: BulkDownloadRequest, request: Request, db: AsyncSession = Depends(get_db),
                        user: User = Depends(get_current_user)):
    """ZIP of recordings (SSH as asciinema .cast, RDP as Guacamole dump) + manifest.csv.
    Each file is integrity-checked (SHA-256) on the way out; failures are listed, not hidden."""
    query = select(SessionRecording).where(SessionRecording.id.in_(body.ids))
    if not has_perm(user, "audit"):
        query = query.where(SessionRecording.user_id == user.id)
    recs = (await db.execute(query.order_by(SessionRecording.started_at))).scalars().all()
    if not recs:
        raise HTTPException(status_code=404, detail="No recording found")

    spool = tempfile.SpooledTemporaryFile(max_size=64 * 1024 * 1024)
    manifest = io.StringIO()
    w = csv.writer(manifest)
    w.writerow(["fichier", "session", "protocole", "utilisateur", "serveur", "compte", "debut", "fin",
                "sha256_stocke", "integrite"])
    ok = 0
    with zipfile.ZipFile(spool, "w", zipfile.ZIP_DEFLATED) as z:
        for rec in recs:
            stamp = rec.started_at.strftime("%Y%m%d-%H%M%S") if rec.started_at else "inconnu"
            base = f"{stamp}_{rec.protocol}_{rec.session_id[:12]}"
            status_txt, name = "ok", ""
            try:
                if rec.storage_key:
                    content = await recording_storage.load(db, rec.storage_type, rec.storage_key, rec.sha256)
                elif rec.events is not None:
                    content = json.dumps(rec.events).encode()
                else:
                    raise recording_storage.StorageError("contenu absent (session en cours ?)")
                if rec.protocol == "rdp":
                    name = base + ".guac"
                    z.writestr(name, content)
                else:
                    name = base + ".cast"
                    z.writestr(name, to_asciicast(json.loads(content), rec))
                ok += 1
            except recording_storage.IntegrityError as e:
                status_txt = f"ALTERE : {e}"
            except Exception as e:  # noqa: BLE001
                status_txt = f"erreur : {e}"[:300]
            w.writerow([name, rec.session_id, rec.protocol, rec.user_name, rec.server_name, rec.account or "",
                        rec.started_at.isoformat() if rec.started_at else "",
                        rec.ended_at.isoformat() if rec.ended_at else "", rec.sha256 or "", status_txt])
        z.writestr("manifest.csv", manifest.getvalue())
    db.add(AuditLog(user_id=user.id, action="recording.download",
                    ip_address=getattr(request.state, "client_ip", None),
                    result=f"{ok}/{len(recs)} enregistrement(s) : " + ", ".join(r.session_id[:12] for r in recs)[:400]))
    await db.commit()
    spool.seek(0)

    def _iter():
        try:
            while chunk := spool.read(256 * 1024):
                yield chunk
        finally:
            spool.close()
    return StreamingResponse(_iter(), media_type="application/zip",
                             headers={"Content-Disposition": "attachment; filename=citadel-enregistrements.zip",
                                      "Cache-Control": "no-store"})
