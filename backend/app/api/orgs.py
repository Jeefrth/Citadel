"""Organisations (SaaS phase 1): my organisations, members and invitations of
the current one, platform administration of every organisation."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user, require_role, user_orgs
from app.core.database import get_db
from app.models.audit import AuditLog
from app.models.base import UserRole
from app.models.organization import OrgInvitation, OrgMembership, Organization
from app.models.user import User
from app.schemas.user import UserRead, UserUpdate
from app.services import orgs as orgs_svc
from app.services import roles as roles_svc

router = APIRouter()
org_admin = require_role(UserRole.ADMIN)


async def require_platform_admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_platform_admin or getattr(user, "_via_access_key", False):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Platform administrator only")
    return user


def _org_read(o: Organization, members: int | None = None) -> dict:
    return {"id": str(o.id), "name": o.name, "slug": o.slug, "is_active": o.is_active, "is_default": o.is_default,
            "has_own_key": o.transit_key is not None, "has_own_ca": o.ssh_ca_public is not None,
            "created_at": o.created_at, "members": members}


# ── Me ──

@router.get("/orgs/mine")
async def my_orgs(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    return [{**_org_read(o), "role": m.role.value if m else UserRole.ADMIN.value, "current": o.id == user.org_id}
            for o, m in await user_orgs(db, user)]


# ── Members of the current organisation ──

class InviteIn(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    role: UserRole = UserRole.VIEWER


@router.get("/org/members", response_model=list[UserRead])
async def list_members(db: AsyncSession = Depends(get_db), _: User = Depends(org_admin)):
    return await roles_svc.list_members(db)


@router.patch("/org/members/{user_id}", response_model=UserRead)
async def update_member(user_id: uuid.UUID, data: UserUpdate, db: AsyncSession = Depends(get_db),
                        actor: User = Depends(org_admin)):
    target, _ = await roles_svc.get_member(db, user_id)
    return await roles_svc.apply_user_update(db, target, data, actor)


@router.delete("/org/members/{user_id}", status_code=204)
async def remove_member(user_id: uuid.UUID, db: AsyncSession = Depends(get_db), actor: User = Depends(org_admin)):
    if user_id == actor.id:
        raise HTTPException(status_code=400, detail="Impossible de vous retirer vous-même")
    await roles_svc.remove_member(db, user_id, actor)


@router.get("/org/invitations")
async def list_invitations(db: AsyncSession = Depends(get_db), user: User = Depends(org_admin)):
    rows = (await db.execute(select(OrgInvitation).where(OrgInvitation.org_id == user.org_id)
                             .order_by(OrgInvitation.created_at.desc()))).scalars().all()
    return [{"id": str(i.id), "email": i.email, "role": i.role.value, "created_at": i.created_at} for i in rows]


@router.post("/org/invitations", status_code=201)
async def create_invitation(data: InviteIn, db: AsyncSession = Depends(get_db), user: User = Depends(org_admin)):
    if getattr(user, "_via_access_key", False):
        raise HTTPException(status_code=403, detail="Not allowed with an access key")
    return await orgs_svc.invite(db, user.org, data.email, data.role, user)


@router.delete("/org/invitations/{invitation_id}", status_code=204)
async def delete_invitation(invitation_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(org_admin)):
    inv = (await db.execute(select(OrgInvitation).where(
        OrgInvitation.id == invitation_id, OrgInvitation.org_id == user.org_id))).scalar_one_or_none()
    if inv is None:
        raise HTTPException(status_code=404, detail="Invitation not found")
    db.add(AuditLog(user_id=user.id, action="org.invite.delete", result=inv.email))
    await db.delete(inv)
    await db.commit()


# ── Platform: every organisation ──

class OrgIn(BaseModel):
    name: str = Field(min_length=2, max_length=255)
    slug: str = Field(min_length=3, max_length=63)
    admin_email: str | None = Field(default=None, max_length=255)


class OrgPatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=255)
    is_active: bool | None = None


@router.get("/platform/orgs")
async def platform_list(db: AsyncSession = Depends(get_db), _: User = Depends(require_platform_admin)):
    counts = dict((await db.execute(select(OrgMembership.org_id, func.count()).where(OrgMembership.is_active.is_(True))
                                    .group_by(OrgMembership.org_id))).all())
    rows = (await db.execute(select(Organization).order_by(Organization.is_default.desc(), Organization.name))).scalars().all()
    return [_org_read(o, counts.get(o.id, 0)) for o in rows]


@router.post("/platform/orgs", status_code=201)
async def platform_create(data: OrgIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_platform_admin)):
    org = await orgs_svc.create_org(db, data.name, data.slug, data.admin_email, user)
    return _org_read(org, 1 if data.admin_email else 0)


@router.patch("/platform/orgs/{org_id}")
async def platform_update(org_id: uuid.UUID, data: OrgPatch, db: AsyncSession = Depends(get_db),
                          user: User = Depends(require_platform_admin)):
    org = await db.get(Organization, org_id)
    if org is None:
        raise HTTPException(status_code=404, detail="Organisation not found")
    if data.is_active is False and org.is_default:
        raise HTTPException(status_code=400, detail="L'organisation par défaut ne peut pas être désactivée")
    changes = []
    if data.name is not None and data.name != org.name:
        changes.append(f"name {org.name} -> {data.name}")
        org.name = data.name
    if data.is_active is not None and data.is_active != org.is_active:
        changes.append("activée" if data.is_active else "désactivée")
        org.is_active = data.is_active
    if changes:
        from app.core import tenancy
        with tenancy.tenant(org.id):
            await tenancy.apply_to_session(db)
            db.add(AuditLog(user_id=user.id, action="org.update", result=f"{org.slug}: {', '.join(changes)}"))
            await db.commit()
    return _org_read(org)
