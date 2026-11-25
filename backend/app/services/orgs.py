"""Organisations: creation (own encryption key and SSH CA), invitations."""

import re

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import tenancy
from app.core.security import create_org_key, new_org_key_name
from app.models.audit import AuditLog
from app.models.base import UserRole
from app.models.organization import OrgInvitation, OrgMembership, Organization
from app.models.user import User

SLUG_RE = re.compile(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]")
RESERVED = {"default", "admin", "api", "platform", "www", "app", "citadel"}


def _looks_like_id(slug: str) -> bool:
    """A slug must never be confusable with an organisation id (X-Citadel-Org takes both)."""
    import uuid as _uuid
    try:
        _uuid.UUID(slug)
        return True
    except ValueError:
        return False


def check_slug(slug: str) -> str:
    slug = (slug or "").strip().lower()
    if not SLUG_RE.fullmatch(slug) or slug in RESERVED or _looks_like_id(slug):
        raise HTTPException(status_code=400, detail="Identifiant invalide : 3 à 63 caractères, minuscules, chiffres et tirets")
    return slug


async def create_org(db: AsyncSession, name: str, slug: str, admin_email: str | None, actor: User) -> Organization:
    """Platform admin: a new, empty organisation with its own Transit key and SSH CA."""
    from app.services.ca_service import generate_org_ca
    slug = check_slug(slug)
    if (await db.execute(select(Organization.id).where(Organization.slug == slug))).first():
        raise HTTPException(status_code=409, detail="Cet identifiant est déjà pris")
    org = Organization(name=name.strip()[:255], slug=slug, is_active=True, is_default=False)
    db.add(org)
    await db.flush()
    org.transit_key = new_org_key_name(org.id)
    create_org_key(org.transit_key)
    with tenancy.tenant(org):   # the CA private key is encrypted with the new key
        await tenancy.apply_to_session(db)   # row level security: rows of the new organisation
        org.ssh_ca_public, org.ssh_ca_private = generate_org_ca(f"citadel-ca-{slug}")
        db.add(AuditLog(org_id=org.id, user_id=actor.id, action="org.create", result=f"{org.name} ({slug})"))
        if admin_email:
            await invite(db, org, admin_email, UserRole.ADMIN, actor, commit=False, direct=True)
        await db.commit()
    return org


async def invite(db: AsyncSession, org: Organization, email: str, role: UserRole, actor: User,
                 commit: bool = True, direct: bool = False) -> dict:
    """An invitation the person accepts themselves once signed in (Mon compte).
    The answer is the same whether or not the address has an account: an
    organisation learns nothing about other customers' people. direct=True
    (platform admins only: first admin of a new organisation) adds a known
    person right away."""
    email = (email or "").strip().lower()
    if "@" not in email or len(email) > 255 or "#ext#" in email:
        raise HTTPException(status_code=400, detail="Adresse e-mail invalide")
    if direct:
        user = (await db.execute(select(User).where(func.lower(User.email) == email))).scalars().first()
        if user is not None:
            m = (await db.execute(select(OrgMembership).where(
                OrgMembership.org_id == org.id, OrgMembership.user_id == user.id))).scalar_one_or_none()
            if m is None:
                db.add(OrgMembership(org_id=org.id, user_id=user.id, role=role))
            db.add(AuditLog(org_id=org.id, user_id=actor.id, action="org.member.add", result=f"{email} {role.value}"))
            if commit:
                await db.commit()
            return {"status": "member", "email": email, "role": role.value}
    inv = (await db.execute(select(OrgInvitation).where(
        OrgInvitation.org_id == org.id, func.lower(OrgInvitation.email) == email))).scalar_one_or_none()
    if inv is None:
        db.add(OrgInvitation(org_id=org.id, email=email, role=role, invited_by=actor.id))
    else:
        inv.role = role
    db.add(AuditLog(org_id=org.id, user_id=actor.id, action="org.invite", result=f"{email} {role.value}"))
    if commit:
        await db.commit()
    return {"status": "invited", "email": email, "role": role.value}


def _my_email(user: User) -> str:
    email = (user.email or "").strip().lower()
    return "" if "#ext#" in email else email


async def my_invitations(db: AsyncSession, user: User) -> list[OrgInvitation]:
    email = _my_email(user)
    if not email:
        return []
    return list((await db.execute(
        select(OrgInvitation).join(Organization, Organization.id == OrgInvitation.org_id)
        .where(func.lower(OrgInvitation.email) == email, Organization.is_active.is_(True))
        .order_by(OrgInvitation.created_at))).scalars().all())


async def answer_invitation(db: AsyncSession, user: User, invitation_id, accept: bool) -> dict:
    """The invited person accepts (membership with the invited role) or declines."""
    inv = next((i for i in await my_invitations(db, user) if str(i.id) == str(invitation_id)), None)
    if inv is None:
        raise HTTPException(status_code=404, detail="Invitation not found")
    org = await db.get(Organization, inv.org_id)
    with tenancy.tenant(org):
        await tenancy.apply_to_session(db)
        if accept:
            exists = (await db.execute(select(OrgMembership).where(
                OrgMembership.org_id == org.id, OrgMembership.user_id == user.id))).scalar_one_or_none()
            if exists is None:
                db.add(OrgMembership(org_id=org.id, user_id=user.id, role=inv.role))
        db.add(AuditLog(user_id=user.id, action="org.invite.accept" if accept else "org.invite.decline",
                        result=f"{inv.email} {inv.role.value}"))
        await db.delete(inv)
        await db.commit()
    return {"accepted": accept, "org": {"id": str(org.id), "name": org.name, "slug": org.slug}}
