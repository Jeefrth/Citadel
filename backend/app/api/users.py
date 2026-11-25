import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user, require_role
from app.core.database import get_db
from app.models.user import User
from app.models.base import UserRole
from app.schemas.user import UserRead, UserUpdate
from app.services.roles import apply_user_update

router = APIRouter()


@router.get("/", response_model=list[UserRead])
async def list_users(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Admins, and custom roles that pick users (policies) or filter by user (audit)."""
    from app.core.auth import has_perm
    if not (has_perm(user, "policies") or has_perm(user, "audit") or has_perm(user, "kubernetes")):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission 'policies' or 'audit' required")
    from app.services.roles import list_members
    return await list_members(db)


@router.patch("/{user_id}", response_model=UserRead)
async def update_user(
    user_id: uuid.UUID,
    data: UserUpdate,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_role(UserRole.ADMIN)),
):
    from app.services.roles import get_member
    user, _ = await get_member(db, user_id)
    return await apply_user_update(db, user, data, actor)
