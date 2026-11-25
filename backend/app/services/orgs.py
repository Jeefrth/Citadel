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


def check_slug(slug: str) -> str:
    slug = (slug or "").strip().lower()
    if not SLUG_RE.fullmatch(slug) or slug in RESERVED:
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
            await invite(db, org, admin_email, UserRole.ADMIN, actor, commit=False)
        await db.commit()
    return org


async def invite(db: AsyncSession, org: Organization, email: str, role: UserRole, actor: User,
                 commit: bool = True) -> dict:
    """A known person becomes a member now; otherwise an invitation, turned into
    a membership at their first sign-in."""
    email = (email or "").strip().lower()
    if "@" not in email or len(email) > 255:
        raise HTTPException(status_code=400, detail="Adresse e-mail invalide")
    user = (await db.execute(select(User).where(func.lower(User.email) == email))).scalars().first()
    if user is not None:
        m = (await db.execute(select(OrgMembership).where(
            OrgMembership.org_id == org.id, OrgMembership.user_id == user.id))).scalar_one_or_none()
        if m is not None:
            raise HTTPException(status_code=409, detail="Cette personne est déjà membre")
        db.add(OrgMembership(org_id=org.id, user_id=user.id, role=role))
        result = {"status": "member", "email": email, "role": role.value}
    else:
        inv = (await db.execute(select(OrgInvitation).where(
            OrgInvitation.org_id == org.id, func.lower(OrgInvitation.email) == email))).scalar_one_or_none()
        if inv is None:
            db.add(OrgInvitation(org_id=org.id, email=email, role=role, invited_by=actor.id))
        else:
            inv.role = role
        result = {"status": "invited", "email": email, "role": role.value}
    db.add(AuditLog(org_id=org.id, user_id=actor.id, action="org.invite", result=f"{email} {role.value} ({result['status']})"))
    if commit:
        await db.commit()
    return result
