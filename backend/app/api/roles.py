"""Custom roles (lot 7): admins only."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import CAPABILITIES, require_role
from app.core.database import get_db
from app.models.audit import AuditLog
from app.models.base import UserRole
from app.models.identity import CustomRole
from app.models.user import User
from app.services.roles import check_permissions

router = APIRouter()
admin_only = require_role(UserRole.ADMIN)


class RoleIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=500)
    permissions: list[str] = Field(default_factory=list)


async def _read(db: AsyncSession, r: CustomRole) -> dict:
    members = (await db.execute(select(func.count(User.id)).where(User.custom_role_id == r.id))).scalar_one()
    return {"id": str(r.id), "name": r.name, "description": r.description, "permissions": r.permissions or [],
            "members": members, "created_at": r.created_at}


@router.get("/capabilities")
async def capabilities(_: User = Depends(admin_only)):
    return CAPABILITIES


@router.get("/custom-roles")
async def list_roles(db: AsyncSession = Depends(get_db), _: User = Depends(admin_only)):
    return [await _read(db, r) for r in (await db.execute(select(CustomRole).order_by(CustomRole.name))).scalars().all()]


@router.post("/custom-roles", status_code=201)
async def create_role(data: RoleIn, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    if (await db.execute(select(CustomRole.id).where(CustomRole.name == data.name))).first():
        raise HTTPException(status_code=409, detail="A role with this name already exists")
    r = CustomRole(name=data.name, description=data.description, permissions=check_permissions(data.permissions))
    db.add(r)
    db.add(AuditLog(user_id=user.id, action="custom_role.create", result=f"{data.name}: {r.permissions}"))
    await db.commit()
    await db.refresh(r)
    return await _read(db, r)


@router.put("/custom-roles/{role_id}")
async def update_role(role_id: uuid.UUID, data: RoleIn, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    r = await db.get(CustomRole, role_id)
    if not r:
        raise HTTPException(status_code=404, detail="Role not found")
    r.name, r.description, r.permissions = data.name, data.description, check_permissions(data.permissions)
    db.add(AuditLog(user_id=user.id, action="custom_role.update", result=f"{data.name}: {r.permissions}"))
    await db.commit()
    return await _read(db, r)


@router.delete("/custom-roles/{role_id}", status_code=204)
async def delete_role(role_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    r = await db.get(CustomRole, role_id)
    if not r:
        raise HTTPException(status_code=404, detail="Role not found")
    db.add(AuditLog(user_id=user.id, action="custom_role.delete", result=f"{r.name} (membres : rôle de base seul)"))
    await db.delete(r)
    await db.commit()
