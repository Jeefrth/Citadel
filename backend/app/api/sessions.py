"""Session recordings: list, replay (SSH events / RDP guac dump), integrity, deletion."""

import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user, require_role
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
    protocol: str | None = Query(default=None, pattern="^(ssh|rdp)$"),
    limit: int = Query(default=50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List recorded sessions (admins: all, others: their own)."""
    query = select(SessionRecording).order_by(SessionRecording.started_at.desc())
    if user.role != UserRole.ADMIN:
        query = query.where(SessionRecording.user_id == user.id)
    if server_id:
        query = query.where(SessionRecording.server_id == server_id)
    if protocol:
        query = query.where(SessionRecording.protocol == protocol)
    return (await db.execute(query.limit(limit))).scalars().all()


async def _get_visible(db: AsyncSession, user: User, recording_id: uuid.UUID) -> SessionRecording:
    rec = (await db.execute(select(SessionRecording).where(SessionRecording.id == recording_id))).scalar_one_or_none()
    if not rec or (user.role != UserRole.ADMIN and rec.user_id != user.id):
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
    if rec.protocol != "ssh":
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
                           user: User = Depends(require_role(UserRole.ADMIN))):
    """Re-read the stored object and check its SHA-256."""
    rec = await _get_visible(db, user, recording_id)
    if not rec.storage_key:
        return {"ok": rec.events is not None, "message": "Ancien enregistrement stocké en base (sans empreinte)"}
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
