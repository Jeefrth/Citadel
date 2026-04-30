import uuid
import json

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user, require_role
from app.core.database import get_db
from app.models.user import User
from app.models.base import UserRole
from app.models.metric import AlertRule
from app.services import settings_service, ca_service
from app.schemas.user import UserRead, UserUpdate

router = APIRouter()


# ── Settings ─────────────────────────────────────────────


class SettingUpdate(BaseModel):
    value: str


class SettingResponse(BaseModel):
    key: str
    value: str
    description: str
    is_default: bool


@router.get("/settings", response_model=dict[str, SettingResponse])
async def get_all_settings(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    """Get all application settings."""
    all_settings = await settings_service.get_all_settings(db)
    return {
        key: SettingResponse(key=key, **meta)
        for key, meta in all_settings.items()
    }


@router.put("/settings/{key}")
async def update_setting(
    key: str,
    body: SettingUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    """Update a setting value."""
    if key not in settings_service.DEFAULTS:
        raise HTTPException(status_code=404, detail=f"Unknown setting: {key}")

    # Validate JSON settings
    if key in ("ip_allowlist", "command_blocklist"):
        try:
            json.loads(body.value)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid JSON value")

    await settings_service.set_setting(db, key, body.value)
    return {"key": key, "value": body.value}


@router.post("/settings/reset/{key}")
async def reset_setting(
    key: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    """Reset a setting to its default value."""
    if key not in settings_service.DEFAULTS:
        raise HTTPException(status_code=404, detail=f"Unknown setting: {key}")

    default_value = settings_service.DEFAULTS[key]["value"]
    await settings_service.set_setting(db, key, default_value)
    return {"key": key, "value": default_value}


# ── Users Management ─────────────────────────────────────


@router.get("/users", response_model=list[UserRead])
async def list_users(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    result = await db.execute(select(User).order_by(User.display_name))
    return result.scalars().all()


@router.patch("/users/{user_id}", response_model=UserRead)
async def update_user(
    user_id: uuid.UUID,
    data: UserUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    update_data = data.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(user, field, value)

    await db.commit()
    await db.refresh(user)
    return user


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    await db.delete(user)
    await db.commit()


# ── CA Info ──────────────────────────────────────────────


@router.get("/ca/info")
async def get_ca_info(
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    """Get CA certificate information."""
    pub_key = ca_service.get_ca_public_key()
    return {
        "public_key": pub_key,
        "key_path": str(ca_service.CA_DIR),
        "algorithm": "Ed25519",
    }


# ── System ───────────────────────────────────────────────


@router.get("/system")
async def get_system_info(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    """Get system overview."""
    from app.models.server import Server
    from app.models.session_recording import SessionRecording
    from app.models.audit import AuditLog
    from sqlalchemy import func

    server_count = (await db.execute(select(func.count(Server.id)))).scalar_one()
    user_count = (await db.execute(select(func.count(User.id)))).scalar_one()
    session_count = (await db.execute(select(func.count(SessionRecording.id)))).scalar_one()
    audit_count = (await db.execute(select(func.count(AuditLog.id)))).scalar_one()
    alert_count = (await db.execute(select(func.count(AlertRule.id)))).scalar_one()

    return {
        "version": "0.1.0",
        "servers": server_count,
        "users": user_count,
        "sessions": session_count,
        "audit_entries": audit_count,
        "alert_rules": alert_count,
    }
