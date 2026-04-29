import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select, delete as sa_delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user, require_role
from app.core.database import get_db
from app.models.user import User
from app.models.session_recording import SessionRecording
from app.models.base import UserRole
from app.schemas.session import SessionRecordingList, SessionRecordingDetail

router = APIRouter()


@router.get("/", response_model=list[SessionRecordingList])
async def list_sessions(
    server_id: uuid.UUID | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List recorded sessions, optionally filtered by server."""
    query = select(SessionRecording).order_by(SessionRecording.started_at.desc())

    if server_id:
        query = query.where(SessionRecording.server_id == server_id)

    query = query.limit(limit)
    result = await db.execute(query)
    return result.scalars().all()


@router.get("/{recording_id}", response_model=SessionRecordingDetail)
async def get_session(
    recording_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get a session recording with all events for replay."""
    result = await db.execute(
        select(SessionRecording).where(SessionRecording.id == recording_id)
    )
    recording = result.scalar_one_or_none()
    if not recording:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Recording not found"
        )
    return recording


@router.delete("/{recording_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    recording_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    """Delete a session recording."""
    result = await db.execute(
        select(SessionRecording).where(SessionRecording.id == recording_id)
    )
    recording = result.scalar_one_or_none()
    if not recording:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Recording not found"
        )
    await db.delete(recording)
    await db.commit()
