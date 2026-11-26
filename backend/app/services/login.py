"""Who gets in after a provider sign-in (SaaS phase 3).

- A known identity (issuer + subject) signs in as its person.
- Otherwise a Citadel account is created only when:
  - an invitation waits for the address, and the provider vouches for it
    (verified e-mail); the invitation is then accepted from Mon compte;
  - or the provider is the SSO of an organisation that lets newcomers in
    (jit_role), for an address of its domains if it lists any;
  - or nobody has signed in yet (first person = platform admin).
- Anything else is refused: no account is created.
An existing person is never matched by e-mail alone: linking another provider
is done from Mon compte while signed in.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import tenancy
from app.models.auth import IdentityProvider, UserIdentity
from app.models.base import UserRole
from app.models.organization import OrgInvitation, OrgMembership, Organization
from app.models.user import User
from app.services.oidc import ExternalIdentity


class LoginRefused(Exception):
    """Message safe to show on the sign-in page."""


def _domain(email: str) -> str:
    return email.rsplit("@", 1)[1].lower() if "@" in email else ""


def trusted_email(provider: IdentityProvider, ident: ExternalIdentity) -> str:
    """The address, if Citadel can rely on it (invitations, account e-mail):
    verified by a platform provider, or by an organisation SSO for one of the
    domains a platform admin approved for it. Anything else is ignored: an
    organisation's own provider can claim any address."""
    if not (ident.email and ident.email_verified):
        return ""
    if provider.org_id is None:
        return ident.email
    if _domain(ident.email) in [d.lower() for d in (provider.verified_domains or [])]:
        return ident.email
    return ""


def domain_allowed(provider: IdentityProvider, ident: ExternalIdentity) -> bool:
    """An organisation SSO listing domains only accepts its own addresses."""
    doms = [d.lower() for d in (provider.domains or [])]
    return not doms or (ident.email_verified and _domain(ident.email) in doms)


async def resolve_person(db: AsyncSession, provider: IdentityProvider, ident: ExternalIdentity) -> User:
    now = datetime.now(timezone.utc)
    if not domain_allowed(provider, ident):
        raise LoginRefused("Cette adresse n'est pas autorisée par le SSO de l'organisation")
    link = (await db.execute(select(UserIdentity).where(
        UserIdentity.issuer == ident.issuer, UserIdentity.subject == ident.subject))).scalar_one_or_none()
    if link is not None:
        user = await db.get(User, link.user_id)
        if user is None or not user.is_active:
            raise LoginRefused("Compte désactivé")
        email = trusted_email(provider, ident)
        link.email, link.email_verified, link.last_login_at = ident.email, bool(email), now
        link.provider_id = provider.id
        if not user.email and email:
            user.email = email
        user.display_name = ident.name or user.display_name
        user.last_login = now
        return user

    # Unknown identity: create the person only if something expects them
    invited = False
    email = trusted_email(provider, ident)
    if email:
        invited = (await db.execute(select(func.count(OrgInvitation.id)).join(
            Organization, Organization.id == OrgInvitation.org_id).where(
            func.lower(OrgInvitation.email) == email, Organization.is_active.is_(True)))).scalar_one() > 0
    jit = provider.org_id is not None and provider.jit_role is not None
    first = (await db.execute(select(func.count(User.id)).where(~User.entra_object_id.like("dev-mode%")))).scalar_one() == 0
    if not (invited or jit or first):
        raise LoginRefused("Aucun compte Citadel pour cette identité. Demandez une invitation à l'administrateur "
                           "de votre organisation.")
    # only a trusted address goes on the account (invitations are matched on it)
    user = User(entra_object_id=f"idp:{uuid.uuid4()}", email=email, display_name=ident.name or email or "Utilisateur",
                is_active=True, is_platform_admin=first, last_login=now)
    db.add(user)
    await db.flush()
    db.add(UserIdentity(user_id=user.id, provider_id=provider.id, issuer=ident.issuer, subject=ident.subject,
                        email=ident.email, email_verified=bool(email), last_login_at=now))
    if first:
        default = (await db.execute(select(Organization).where(Organization.is_default.is_(True)))).scalar_one_or_none()
        if default is not None:
            db.add(OrgMembership(org_id=default.id, user_id=user.id, role=UserRole.ADMIN))
    await _jit(db, provider, user)
    return user


async def _jit(db: AsyncSession, provider: IdentityProvider, user: User) -> None:
    """Organisation SSO with arrival without invitation: membership when the
    account is created through it. Only then: someone removed later is never
    added back by signing in again."""
    if provider.org_id is None or provider.jit_role is None:
        return
    org = await db.get(Organization, provider.org_id)
    if org is None or not org.is_active:
        return
    exists = (await db.execute(select(OrgMembership.id).where(
        OrgMembership.org_id == org.id, OrgMembership.user_id == user.id))).first()
    if not exists:
        db.add(OrgMembership(org_id=org.id, user_id=user.id, role=provider.jit_role))


async def providers_for_login(db: AsyncSession) -> list[IdentityProvider]:
    """Buttons of the sign-in page: active platform providers."""
    return list((await db.execute(select(IdentityProvider).where(
        IdentityProvider.org_id.is_(None), IdentityProvider.is_active.is_(True)).order_by(IdentityProvider.name))).scalars().all())


async def discover(db: AsyncSession, value: str) -> list[IdentityProvider]:
    """Organisation SSO from an e-mail address (its domains) or an organisation identifier."""
    value = (value or "").strip().lower()
    if not value:
        return []
    q = select(IdentityProvider).join(Organization, Organization.id == IdentityProvider.org_id).where(
        IdentityProvider.is_active.is_(True), Organization.is_active.is_(True))
    rows = (await db.execute(q)).scalars().all()
    if "@" in value:   # approved domains only: an organisation cannot capture another one's people
        dom = _domain(value)
        return [p for p in rows if dom in [d.lower() for d in (p.verified_domains or [])]]
    org = (await db.execute(select(Organization).where(Organization.slug == value))).scalar_one_or_none()
    return [p for p in rows if org is not None and p.org_id == org.id]


async def client_secret(db: AsyncSession, provider: IdentityProvider) -> str | None:
    """The provider's secret, decrypted with its organisation's key (platform: default key)."""
    from app.core.config import settings
    from app.core.security import decrypt_value
    if provider.encrypted_client_secret:
        if provider.org_id is None:
            async with tenancy.system_in(db):
                return decrypt_value(provider.encrypted_client_secret)
        org = await db.get(Organization, provider.org_id)
        with tenancy.tenant(org):
            return decrypt_value(provider.encrypted_client_secret)
    # Entra provider of the default organisation (migrated): secret from the environment.
    # Only for that exact tenant and application, so the secret never goes to another server.
    if (provider.kind == "entra" and settings.AZURE_CLIENT_SECRET and settings.AZURE_TENANT_ID
            and provider.client_id == settings.AZURE_CLIENT_ID
            and provider.issuer.rstrip("/") == f"https://login.microsoftonline.com/{settings.AZURE_TENANT_ID}/v2.0"):
        org = await db.get(Organization, provider.org_id) if provider.org_id else None
        if org is not None and org.is_default:
            return settings.AZURE_CLIENT_SECRET
    return None
