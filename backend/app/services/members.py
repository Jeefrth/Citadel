"""Users of the current organisation (SaaS phase 1).

Users are global; what a user is inside an organisation is its OrgMembership.
Any query listing or resolving users for organisation data must go through
these helpers, so that people of another organisation never show up."""

import uuid

from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tenancy import require_org_id
from app.models.base import UserRole
from app.models.organization import OrgMembership
from app.models.user import User


def member_ids_subquery(role: UserRole | None = None, org_id: uuid.UUID | None = None):
    q = select(OrgMembership.user_id).where(OrgMembership.org_id == (org_id or require_org_id()),
                                            OrgMembership.is_active.is_(True))
    if role is not None:
        q = q.where(OrgMembership.role == role)
    return q


def members_query(active_only: bool = True) -> Select:
    """select(User) restricted to the members of the current organisation."""
    q = select(User).where(User.id.in_(member_ids_subquery()))
    if active_only:
        q = q.where(User.is_active.is_(True))
    return q


def is_member_clause():
    return User.id.in_(member_ids_subquery())


async def admin_ids(db: AsyncSession) -> list:
    rows = await db.execute(select(User.id).where(User.id.in_(member_ids_subquery(UserRole.ADMIN)),
                                                  User.is_active.is_(True)).order_by(User.created_at))
    return [r[0] for r in rows.all()]


async def membership(db: AsyncSession, user_id, org_id: uuid.UUID | None = None) -> OrgMembership | None:
    return (await db.execute(select(OrgMembership).where(
        OrgMembership.org_id == (org_id or require_org_id()), OrgMembership.user_id == user_id))).scalar_one_or_none()


async def roles_by_user(db: AsyncSession) -> dict:
    """{user_id: OrgMembership} for the current organisation."""
    rows = (await db.execute(select(OrgMembership).where(OrgMembership.org_id == require_org_id()))).scalars().all()
    return {m.user_id: m for m in rows}


async def filter_member_ids(db: AsyncSession, ids) -> list:
    """Keep only ids of users who are members of the current organisation."""
    ids = [uuid.UUID(str(i)) for i in ids or []]
    if not ids:
        return []
    rows = await db.execute(select(OrgMembership.user_id).where(
        OrgMembership.org_id == require_org_id(), OrgMembership.user_id.in_(ids)))
    ok = {r[0] for r in rows.all()}
    return [i for i in ids if i in ok]


async def names(db: AsyncSession) -> dict:
    """{user_id: display_name} of people known to the current organisation:
    members (also suspended) and anyone in its audit trail (former members)."""
    from app.models.audit import AuditLog
    org = require_org_id()
    known = select(OrgMembership.user_id).where(OrgMembership.org_id == org).union(
        select(AuditLog.user_id).where(AuditLog.org_id == org).distinct())
    rows = await db.execute(select(User.id, User.display_name).where(User.id.in_(known)))
    return dict(rows.all())


async def require_member(db: AsyncSession, user_id) -> None:
    from fastapi import HTTPException
    if user_id is None or await membership(db, user_id) is None:
        raise HTTPException(status_code=404, detail="User not found")


async def load_member(db: AsyncSession, user_id, require_active: bool = True) -> User | None:
    """Another person, bound with their role in the current organisation (to
    evaluate their rights), or None if they are not a member. Platform admins
    are admins everywhere. Never use it on the request's own user instance
    with another organisation."""
    from app.models.identity import CustomRole
    from app.models.organization import Organization
    if user_id is None:
        return None
    u = await db.get(User, uuid.UUID(str(user_id)))
    if u is None:
        return None
    m = await membership(db, u.id)
    if m is None and not u.is_platform_admin:
        return None
    if require_active and (not u.is_active or (m is not None and not m.is_active)):
        return None
    u.org = await db.get(Organization, require_org_id())
    u.role = UserRole.ADMIN if u.is_platform_admin else m.role
    u.custom_role = None
    if m is not None and m.custom_role_id:
        u.custom_role = (await db.execute(select(CustomRole).where(CustomRole.id == m.custom_role_id))).scalar_one_or_none()
    return u
