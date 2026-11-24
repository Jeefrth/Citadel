"""Custom roles (lot 7) and user updates (role, custom role, active)."""

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import CAPABILITIES
from app.models.audit import AuditLog
from app.models.base import UserRole
from app.models.identity import CustomRole
from app.models.user import User


def check_permissions(perms: list[str]) -> list[str]:
    unknown = [p for p in perms if p not in CAPABILITIES]
    if unknown:
        raise HTTPException(status_code=400, detail=f"Permissions inconnues : {unknown}")
    return sorted(set(perms))


async def apply_user_update(db: AsyncSession, user: User, data, actor: User) -> User:
    changes = data.model_dump(exclude_unset=True)
    admins = (await db.execute(select(func.count(User.id)).where(
        User.role == UserRole.ADMIN, User.is_active.is_(True)))).scalar_one()
    losing_admin = user.role == UserRole.ADMIN and (
        ("role" in changes and changes["role"] != UserRole.ADMIN) or changes.get("is_active") is False)
    if losing_admin and admins <= 1:
        raise HTTPException(status_code=400, detail="Impossible : ce serait le dernier admin actif")
    if "custom_role_id" in changes and changes["custom_role_id"] is not None:
        if await db.get(CustomRole, changes["custom_role_id"]) is None:
            raise HTTPException(status_code=404, detail="Custom role not found")
    before = f"role={user.role.value} custom={user.custom_role_name} active={user.is_active}"
    for field, value in changes.items():
        setattr(user, field, value)
    await db.flush()
    await db.refresh(user, ["custom_role"])
    db.add(AuditLog(user_id=actor.id, action="user.update",
                    result=f"{user.display_name}: {before} -> role={user.role.value} custom={user.custom_role_name} active={user.is_active}"))
    await db.commit()
    await db.refresh(user, ["custom_role"])
    return user
