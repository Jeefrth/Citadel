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


def member_view(u: User, m, custom_roles: dict | None = None) -> dict:
    """UserRead of a user as seen in the current organisation (never mutates u:
    the instance may be the bound actor)."""
    from app.core.auth import CAPABILITIES
    role = m.role if m is not None else UserRole.VIEWER
    cr = (custom_roles or {}).get(m.custom_role_id) if m is not None and m.custom_role_id else None
    perms = list(CAPABILITIES) if role == UserRole.ADMIN else [p for p in ((cr.permissions or []) if cr else []) if p in CAPABILITIES]
    return {"id": u.id, "entra_object_id": u.entra_object_id, "email": u.email, "display_name": u.display_name,
            "role": role, "is_active": bool(u.is_active and (m is None or m.is_active)),
            "created_at": u.created_at, "last_login": u.last_login,
            "custom_role_id": cr.id if cr else None, "custom_role_name": cr.name if cr else None, "permissions": perms}


async def list_members(db: AsyncSession) -> list[dict]:
    from app.services.members import roles_by_user
    ms = await roles_by_user(db)
    if not ms:
        return []
    crs = {r.id: r for r in (await db.execute(select(CustomRole))).scalars().all()}
    users = (await db.execute(select(User).where(User.id.in_(list(ms))).order_by(User.display_name))).scalars().all()
    return [member_view(u, ms[u.id], crs) for u in users]


async def get_member(db: AsyncSession, user_id):
    """(User, OrgMembership) of the current organisation, or 404."""
    from app.services.members import membership
    m = await membership(db, user_id)
    u = await db.get(User, user_id) if m is not None else None
    if u is None:
        raise HTTPException(status_code=404, detail="User not found")
    return u, m


async def apply_user_update(db: AsyncSession, user: User, data, actor: User) -> dict:
    """Change a member's role, custom role or access in the current organisation."""
    from app.services.members import admin_ids
    u, m = await get_member(db, user.id)
    changes = data.model_dump(exclude_unset=True)
    admins = await admin_ids(db)
    losing_admin = m.role == UserRole.ADMIN and m.is_active and (
        ("role" in changes and changes["role"] != UserRole.ADMIN) or changes.get("is_active") is False)
    if losing_admin and len([a for a in admins if a != u.id]) == 0:
        raise HTTPException(status_code=400, detail="Impossible : ce serait le dernier admin actif")
    crs = {r.id: r for r in (await db.execute(select(CustomRole))).scalars().all()}
    if changes.get("custom_role_id") is not None and changes["custom_role_id"] not in crs:
        raise HTTPException(status_code=404, detail="Custom role not found")
    before = member_view(u, m, crs)
    for field in ("role", "custom_role_id", "is_active"):
        if field in changes and (changes[field] is not None or field == "custom_role_id"):
            setattr(m, field, changes[field])
    after = member_view(u, m, crs)
    db.add(AuditLog(user_id=actor.id, action="user.update",
                    result=f"{u.display_name}: role={before['role'].value} custom={before['custom_role_name']} active={before['is_active']}"
                           f" -> role={after['role'].value} custom={after['custom_role_name']} active={after['is_active']}"))
    await db.commit()
    return after


async def remove_member(db: AsyncSession, user_id, actor: User) -> None:
    """Remove a person from the current organisation (the global account stays)."""
    from app.services.members import admin_ids
    u, m = await get_member(db, user_id)
    if m.role == UserRole.ADMIN and not [a for a in await admin_ids(db) if a != u.id]:
        raise HTTPException(status_code=400, detail="Impossible : ce serait le dernier admin actif")
    await db.delete(m)
    db.add(AuditLog(user_id=actor.id, action="user.remove", result=u.display_name))
    await db.commit()
