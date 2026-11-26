"""Identity providers administration (SaaS phase 3).

- /api/org/identity-providers: SSO of the current organisation (its admins).
- /api/platform/identity-providers: buttons of the sign-in page (platform admins).
Client secrets are write-only and encrypted with the organisation's key
(platform: default key).
"""

import uuid
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.orgs import require_platform_admin
from app.core import tenancy
from app.core.auth import require_role
from app.core.config import settings
from app.core.database import get_db
from app.core.security import encrypt_value
from app.models.audit import AuditLog
from app.models.auth import PROVIDER_KINDS, IdentityProvider
from app.models.base import UserRole
from app.models.user import User
from app.services import oidc

router = APIRouter()
org_admin = require_role(UserRole.ADMIN)


class ProviderIn(BaseModel):
    kind: str = Field(default="oidc", pattern="^(" + "|".join(PROVIDER_KINDS) + ")$")
    name: str = Field(min_length=1, max_length=255)
    issuer: str = Field(min_length=8, max_length=500)
    client_id: str = Field(min_length=1, max_length=255)
    client_secret: str | None = Field(default=None, max_length=2000)   # None: keep the current one
    scopes: str = Field(default="openid email profile", max_length=500)
    domains: list[str] = Field(default_factory=list, max_length=50)
    jit_role: UserRole | None = None
    enforced: bool = False
    is_active: bool = True


def _read(p: IdentityProvider) -> dict:
    return {"id": str(p.id), "kind": p.kind, "name": p.name, "issuer": p.issuer, "client_id": p.client_id,
            "has_secret": p.encrypted_client_secret is not None, "scopes": p.scopes, "domains": p.domains or [],
            "verified_domains": p.verified_domains or [],
            "pending_domains": [d for d in (p.domains or []) if d not in (p.verified_domains or [])],
            "jit_role": p.jit_role.value if p.jit_role else None, "enforced": p.enforced, "is_active": p.is_active,
            "created_at": p.created_at, "redirect_uri": oidc.redirect_uri()}


def _clean_domains(domains: list[str]) -> list[str]:
    out = []
    for d in domains:
        d = d.strip().lower().lstrip("@")
        if not d:
            continue
        if "." not in d or any(c in d for c in " /@:"):
            raise HTTPException(status_code=400, detail=f"Domaine invalide : {d}")
        out.append(d)
    return sorted(set(out))


async def _validate(db: AsyncSession, data: ProviderIn, org_id, exclude=None) -> list[str]:
    issuer = data.issuer.strip().rstrip("/")
    u = urlparse(issuer)
    if u.scheme != "https" and not settings.OIDC_ALLOW_HTTP:
        raise HTTPException(status_code=400, detail="L'émetteur doit être en https://")
    if data.kind == "entra" and u.netloc != oidc.MS_HOST:
        raise HTTPException(status_code=400, detail="Un fournisseur Microsoft Entra a un émetteur sur login.microsoftonline.com")
    if data.jit_role == UserRole.ADMIN:
        raise HTTPException(status_code=400, detail="L'arrivée automatique ne peut pas donner le rôle administrateur")
    if "openid" not in data.scopes.split():
        raise HTTPException(status_code=400, detail="Les scopes doivent contenir « openid »")
    try:
        await oidc.discovery(issuer)
    except oidc.OIDCError as e:
        raise HTTPException(status_code=400, detail=f"Découverte OIDC impossible : {e}")
    domains = _clean_domains(data.domains)
    if domains:
        # a domain belongs to one organisation (discovery from an address must be unambiguous);
        # requested domains only count once a platform admin approved them
        q = select(IdentityProvider).where(IdentityProvider.org_id.is_not(None))
        if org_id is not None:
            q = q.where(IdentityProvider.org_id != org_id)
        for p in (await db.execute(q)).scalars().all():
            taken = set(domains) & {d.lower() for d in (p.domains or [])}
            if taken and p.id != exclude:
                raise HTTPException(status_code=409, detail=f"Domaine déjà utilisé par une autre organisation : {', '.join(sorted(taken))}")
    return domains


def _apply(p: IdentityProvider, data: ProviderIn, domains: list[str]) -> None:
    issuer, client_id = data.issuer.strip().rstrip("/"), data.client_id.strip()
    moved = p.issuer is not None and (p.issuer != issuer or p.client_id != client_id or p.kind != data.kind)
    p.kind, p.name, p.issuer, p.client_id = data.kind, data.name.strip(), issuer, client_id
    p.scopes, p.domains, p.jit_role, p.is_active = data.scopes.strip(), domains, data.jit_role, data.is_active
    p.verified_domains = [d for d in (p.verified_domains or []) if d in domains and not moved]
    if data.client_secret:
        p.encrypted_client_secret = encrypt_value(data.client_secret)
    elif moved:
        p.encrypted_client_secret = None   # never send the stored secret to another server or application


def _check_enforce(user: User, p: IdentityProvider, enforced: bool) -> None:
    """Imposing an SSO that does not work would lock the organisation out:
    only allowed while signed in through it."""
    if enforced and not p.enforced and getattr(user, "_session_provider", None) != p.id:
        raise HTTPException(status_code=400, detail="Connectez-vous d'abord avec ce fournisseur pour pouvoir l'imposer")
    p.enforced = enforced


def _no_key(user: User) -> None:
    if getattr(user, "_via_access_key", False):
        raise HTTPException(status_code=403, detail="Not allowed with an access key")


# ── Organisation SSO ──

@router.get("/org/identity-providers")
async def org_list(db: AsyncSession = Depends(get_db), user: User = Depends(org_admin)):
    rows = (await db.execute(select(IdentityProvider).where(IdentityProvider.org_id == user.org_id)
                             .order_by(IdentityProvider.name))).scalars().all()
    return [_read(p) for p in rows]


@router.post("/org/identity-providers", status_code=201)
async def org_create(data: ProviderIn, db: AsyncSession = Depends(get_db), user: User = Depends(org_admin)):
    _no_key(user)
    domains = await _validate(db, data, user.org_id)
    p = IdentityProvider(org_id=user.org_id)
    _apply(p, data, domains)   # secret encrypted with the organisation's key (context)
    if data.enforced:
        raise HTTPException(status_code=400, detail="Créez le fournisseur, connectez-vous avec, puis imposez-le")
    db.add(p)
    db.add(AuditLog(user_id=user.id, action="idp.create", result=f"{p.name} {p.issuer}"))
    await db.commit()
    return _read(p)


async def _org_provider(db, user, provider_id) -> IdentityProvider:
    p = await db.get(IdentityProvider, provider_id)
    if p is None or p.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Provider not found")
    return p


@router.put("/org/identity-providers/{provider_id}")
async def org_update(provider_id: uuid.UUID, data: ProviderIn, db: AsyncSession = Depends(get_db),
                     user: User = Depends(org_admin)):
    _no_key(user)
    p = await _org_provider(db, user, provider_id)
    domains = await _validate(db, data, user.org_id, exclude=p.id)
    _apply(p, data, domains)
    _check_enforce(user, p, data.enforced and data.is_active)
    db.add(AuditLog(user_id=user.id, action="idp.update", result=f"{p.name} enforced={p.enforced} active={p.is_active} jit={data.jit_role}"))
    await db.commit()
    return _read(p)


@router.delete("/org/identity-providers/{provider_id}", status_code=204)
async def org_delete(provider_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(org_admin)):
    _no_key(user)
    p = await _org_provider(db, user, provider_id)
    db.add(AuditLog(user_id=user.id, action="idp.delete", result=p.name))
    await db.delete(p)
    await db.commit()


# ── Platform providers (sign-in page buttons) ──

@router.get("/platform/identity-providers")
async def platform_list(db: AsyncSession = Depends(get_db), _: User = Depends(require_platform_admin)):
    rows = (await db.execute(select(IdentityProvider).where(IdentityProvider.org_id.is_(None))
                             .order_by(IdentityProvider.name))).scalars().all()
    return [_read(p) for p in rows]


@router.post("/platform/identity-providers", status_code=201)
async def platform_create(data: ProviderIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_platform_admin)):
    if data.jit_role is not None or data.enforced or data.domains:
        raise HTTPException(status_code=400, detail="Un fournisseur plateforme n'a ni arrivée automatique, ni domaines, ni obligation")
    await _validate(db, data, None)
    p = IdentityProvider(org_id=None)
    async with tenancy.system_in(db):   # platform secret: default key
        _apply(p, data, [])
        db.add(p)
        db.add(AuditLog(org_id=None, user_id=user.id, action="idp.create", result=f"plateforme {p.name} {p.issuer}"))
        await db.commit()
    return _read(p)


@router.put("/platform/identity-providers/{provider_id}")
async def platform_update(provider_id: uuid.UUID, data: ProviderIn, db: AsyncSession = Depends(get_db),
                          user: User = Depends(require_platform_admin)):
    p = await db.get(IdentityProvider, provider_id)
    if p is None or p.org_id is not None:
        raise HTTPException(status_code=404, detail="Provider not found")
    if data.jit_role is not None or data.enforced or data.domains:
        raise HTTPException(status_code=400, detail="Un fournisseur plateforme n'a ni arrivée automatique, ni domaines, ni obligation")
    await _validate(db, data, None)
    async with tenancy.system_in(db):
        _apply(p, data, [])
        db.add(AuditLog(org_id=None, user_id=user.id, action="idp.update", result=f"plateforme {p.name} active={p.is_active}"))
        await db.commit()
    return _read(p)


@router.delete("/platform/identity-providers/{provider_id}", status_code=204)
async def platform_delete(provider_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_platform_admin)):
    p = await db.get(IdentityProvider, provider_id)
    if p is None or p.org_id is not None:
        raise HTTPException(status_code=404, detail="Provider not found")
    async with tenancy.system_in(db):
        db.add(AuditLog(org_id=None, user_id=user.id, action="idp.delete", result=f"plateforme {p.name}"))
        await db.delete(p)
        await db.commit()


# ── Domain approval (platform admins) ──

class DomainsIn(BaseModel):
    domains: list[str] = Field(default_factory=list, max_length=50)


@router.get("/platform/domain-requests")
async def domain_requests(db: AsyncSession = Depends(get_db), _: User = Depends(require_platform_admin)):
    """Organisation SSO with domains waiting for approval."""
    from app.models.organization import Organization
    rows = (await db.execute(select(IdentityProvider, Organization).join(
        Organization, Organization.id == IdentityProvider.org_id))).all()
    return [{**_read(p), "org": {"id": str(o.id), "name": o.name, "slug": o.slug}} for p, o in rows
            if any(d not in (p.verified_domains or []) for d in (p.domains or []))]


@router.put("/platform/identity-providers/{provider_id}/verified-domains")
async def set_verified_domains(provider_id: uuid.UUID, data: DomainsIn, db: AsyncSession = Depends(get_db),
                               user: User = Depends(require_platform_admin)):
    """Approve (or withdraw) domains of an organisation SSO, after checking the
    organisation really owns them (out of band: DNS, contract...)."""
    p = await db.get(IdentityProvider, provider_id)
    if p is None or p.org_id is None:
        raise HTTPException(status_code=404, detail="Provider not found")
    wanted = _clean_domains(data.domains)
    unknown = [d for d in wanted if d not in (p.domains or [])]
    if unknown:
        raise HTTPException(status_code=400, detail=f"Domaines non demandés par l'organisation : {', '.join(unknown)}")
    for other in (await db.execute(select(IdentityProvider).where(
            IdentityProvider.org_id.is_not(None), IdentityProvider.org_id != p.org_id))).scalars().all():
        taken = set(wanted) & {d.lower() for d in (other.verified_domains or [])}
        if taken:
            raise HTTPException(status_code=409, detail=f"Domaine déjà approuvé pour une autre organisation : {', '.join(sorted(taken))}")
    p.verified_domains = wanted
    async with tenancy.system_in(db):
        db.add(AuditLog(org_id=p.org_id, user_id=user.id, action="idp.domains.approve", result=f"{p.name}: {', '.join(wanted) or '-'}"))
        await db.commit()
    return _read(p)
