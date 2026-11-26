import hashlib
import hmac
from datetime import datetime, timezone

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core import tenancy
from app.models.organization import OrgInvitation, OrgMembership, Organization
from app.models.user import User
from app.models.base import UserRole

ORG_HEADER = "X-Citadel-Org"

security = HTTPBearer(auto_error=False)

async def _default_org(db: AsyncSession) -> Organization | None:
    return (await db.execute(select(Organization).where(Organization.is_default.is_(True)))).scalar_one_or_none()


# ── Organisation binding ──

async def user_orgs(db: AsyncSession, user: User) -> list[tuple[Organization, OrgMembership | None]]:
    """Organisations the user can work in: active memberships of active
    organisations; a platform admin can enter every organisation."""
    rows = (await db.execute(
        select(OrgMembership).join(Organization, Organization.id == OrgMembership.org_id)
        .where(OrgMembership.user_id == user.id, OrgMembership.is_active.is_(True), Organization.is_active.is_(True))
    )).scalars().all()
    out = {m.org_id: (m.organization, m) for m in rows}
    if user.is_platform_admin:
        for o in (await db.execute(select(Organization))).scalars().all():
            out.setdefault(o.id, (o, None))
    return sorted(out.values(), key=lambda om: (not om[0].is_default, om[0].name.lower()))


async def resolve_org(db: AsyncSession, user: User, wanted: str | None = None,
                      org_id=None) -> tuple[Organization, OrgMembership | None]:
    """Pick the organisation of a request: a forced org_id (access key, ticket),
    else the X-Citadel-Org header (slug or id), else the first one."""
    choices = await user_orgs(db, user)
    if org_id is not None:
        match = [om for om in choices if str(om[0].id) == str(org_id)]
        if wanted and match and wanted.strip().lower() not in (str(match[0][0].id), match[0][0].slug):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cette clé n'est valable que dans son organisation")
    elif wanted:
        w = wanted.strip().lower()
        match = [om for om in choices if str(om[0].id) == w] or [om for om in choices if om[0].slug == w]
    else:
        match = choices[:1]
    if not match:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="Organisation inconnue ou non autorisée" if (wanted or org_id) else "Aucune organisation pour ce compte")
    return match[0]


async def bind_user(db: AsyncSession, user: User, org: Organization, membership: OrgMembership | None,
                    ip: str | None = None, check_ip: bool = True) -> None:
    """Enter the organisation: tenant context + RLS for this transaction, and the
    user's role in it. A platform admin without membership is admin."""
    from app.models.identity import CustomRole
    tenancy.set_context(tenancy.TenantContext.for_org(org))
    await tenancy.apply_to_session(db)
    user.org = org
    user.custom_role = None
    if membership is not None:
        user.role = UserRole.ADMIN if user.is_platform_admin else membership.role
        if membership.custom_role_id:
            user.custom_role = (await db.execute(
                select(CustomRole).where(CustomRole.id == membership.custom_role_id))).scalar_one_or_none()
    elif user.is_platform_admin:
        user.role = UserRole.ADMIN
    else:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Pas membre de cette organisation")
    await _enforce_org_sso(db, user, org)
    if check_ip:   # address allow-list of the organisation (phase 2)
        from app.services.org_policy import check_ip as _check_ip
        await _check_ip(db, user, ip)


async def _enforce_org_sso(db: AsyncSession, user: User, org: Organization) -> None:
    """An organisation that imposes its SSO only accepts sessions opened through
    it. Platform admins keep a way in (break-glass); access keys, SSH proxy and
    RDP tickets do not come from a browser session and are not concerned."""
    if user.is_platform_admin or not hasattr(user, "_session_provider"):
        return
    from app.models.auth import IdentityProvider
    enforced = (await db.execute(select(IdentityProvider).where(
        IdentityProvider.org_id == org.id, IdentityProvider.enforced.is_(True),
        IdentityProvider.is_active.is_(True)))).scalars().all()
    if enforced and user._session_provider not in {p.id for p in enforced}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail=f"Cette organisation exige la connexion par {enforced[0].name}")


async def bind_request(db: AsyncSession, user: User, wanted: str | None = None, org_id=None,
                       ip: str | None = None) -> Organization:
    org, membership = await resolve_org(db, user, wanted, org_id)
    await bind_user(db, user, org, membership, ip)
    return org


async def _get_or_create_dev_user(db: AsyncSession) -> User:
    """Get or create a dev admin user for DEV_MODE."""
    dev_oid = "dev-mode-user-00000000"
    result = await db.execute(select(User).where(User.entra_object_id == dev_oid))
    user = result.scalar_one_or_none()

    if user is None:
        user = User(
            entra_object_id=dev_oid,
            email="dev@localhost",
            display_name="Dev Admin",
            is_platform_admin=True,
            is_active=True,
        )
        db.add(user)
        await db.commit()

    return user


async def enforce_login_acl(db: AsyncSession, user: User, ip: str | None,
                            method: str = "entra", user_agent: str | None = None) -> None:
    """Connection ACL, scope "login" (C3): source IP / time window for Citadel itself."""
    from app.core.governance import evaluate_connection
    from app.models.audit import AuditLog

    decision = await evaluate_connection(db, user, "login", ip)
    if decision.action != "allow":
        db.add(AuditLog(user_id=user.id, action="login.denied", status="failure", ip_address=ip,
                        result=f"rule={decision.rule}"))
        from app.services.devices import record_denied
        await record_denied(db, user, ip, f"règle « {decision.rule} »", method, user_agent)
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Access to Citadel denied by rule '{decision.rule}'",
        )


async def get_identity(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> User:
    """FastAPI dependency: the authenticated person, in NO organisation (no tenant
    data reachable). Only for endpoints about the person themselves: their
    organisations and pending invitations."""
    from app.core.config import settings
    if settings.DEV_MODE:
        return await _get_or_create_dev_user(db)
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    user = await authenticate_token(credentials.credentials, db)
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User account is deactivated")
    return user


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> User:
    """FastAPI dependency: validate token and return current user."""
    from app.core.config import settings

    if settings.DEV_MODE:
        from app.core.governance import client_ip as _cip
        user = await _get_or_create_dev_user(db)
        await bind_request(db, user, request.headers.get(ORG_HEADER),
                           ip=_cip(request.client.host if request.client else None, request.headers))
        return user

    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )

    user = await authenticate_token(credentials.credentials, db)

    from app.core.governance import client_ip
    from app.services import devices
    ip = client_ip(request.client.host if request.client else None, request.headers)
    request.state.client_ip = ip
    method = "access_key" if getattr(user, "_via_access_key", False) else "sso"

    if not user.is_active:
        await devices.record_denied(db, user, ip, "compte désactivé", method, request.headers.get("user-agent"))
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account is deactivated",
        )

    # Organisation: an access key works only in its own organisation
    try:
        org = await bind_request(db, user, request.headers.get(ORG_HEADER), getattr(user, "_access_key_org", None), ip)
    except HTTPException as e:
        if e.status_code == 403 and "Adresse IP" in str(e.detail):
            await devices.record_denied(db, user, ip, "adresse IP hors de la liste de l'organisation", method,
                                        request.headers.get("user-agent"))
            await db.commit()
        raise
    from app.services.org_policy import check_rate
    await check_rate(db, org.id, user.id)
    await enforce_login_acl(db, user, ip, method=method, user_agent=request.headers.get("user-agent"))
    await devices.touch(db, user, request, ip, getattr(user, "_access_key_prefix", None))
    return user


ACCESS_KEY_PREFIX = "ctk_"


def hash_access_key(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def _authenticate_access_key(token: str, db: AsyncSession) -> User:
    """Personal API token: ctk_<prefix>_<secret>, only its SHA-256 is stored (F4)."""
    from app.models.pam import AccessKey

    parts = token.split("_", 2)
    if len(parts) != 3:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Malformed access key")
    with tenancy.system():   # the key tells the organisation
        key = (await db.execute(select(AccessKey).where(AccessKey.prefix == parts[1]))).scalar_one_or_none()
    now = datetime.now(timezone.utc)
    if (
        key is None
        or not key.is_active
        or not hmac.compare_digest(key.key_hash, hash_access_key(token))
        or (key.expires_at is not None and key.expires_at < now)
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired access key")
    with tenancy.system():
        key.last_used_at = now
        user = await db.get(User, key.user_id)
        await db.commit()
    user._via_access_key = True  # lets sensitive endpoints refuse token-on-token
    user._access_key_prefix = key.prefix
    user._access_key_org = key.org_id
    return user


async def authenticate_token(token: str, db: AsyncSession) -> User:
    """A Citadel session access token (after a sign-in at a provider) or a
    Citadel access key. Provider tokens are never accepted directly."""
    if token.startswith(ACCESS_KEY_PREFIX):
        return await _authenticate_access_key(token, db)
    from app.services import sessions
    try:
        s, claims = await sessions.verify(db, token)
    except sessions.SessionError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session")
    user = await db.get(User, s.user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session")
    user._session_id = s.id
    user._session_provider = s.provider_id
    user._auth_time = int(claims.get("auth_time") or 0)
    return user


# Administration capabilities a custom role can give (lot 7). Admins have them all.
# Kept admin-only on purpose: users and roles, settings, notification channels,
# recording storage, SIEM, vault maintenance, backups, applications, deleting
# recordings (anything that could grant more rights or export every secret).
CAPABILITIES = {
    "audit": "Audit : journal des commandes, enregistrements de tous, sessions en direct (observer), connexions, appareils, rapports, risques",
    "sessions": "Contrôle des sessions : terminer une session en direct, déconnecter un appareil",
    "servers": "Inventaire : serveurs, comptes, identifiants, nœuds, zones et passerelles, cloud, alertes",
    "secrets": "Secrets : vérification, rotation, historique, collecte des comptes, modèles et push de comptes",
    "policies": "Droits : groupes, règles d'accès (import / export), ACL de connexion et de commandes",
    "playbooks": "Playbooks Ansible : créer et modifier (le contenu s'exécute sur les serveurs)",
    "kubernetes": "Kubernetes : clusters et règles d'accès aux espaces de noms",
}


def has_perm(user: User, cap: str) -> bool:
    if user.role == UserRole.ADMIN:
        return True
    role = getattr(user, "custom_role", None)
    return bool(role and cap in (role.permissions or []))


def require_perm(cap: str):
    """FastAPI dependency: admin, or a custom role granting this capability."""
    if cap not in CAPABILITIES:
        raise ValueError(f"unknown capability {cap}")

    async def _check(user: User = Depends(get_current_user)) -> User:
        if not has_perm(user, cap):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"Permission '{cap}' required")
        return user
    return _check


def require_role(*roles: UserRole):
    """FastAPI dependency factory: require specific roles."""
    async def _check_role(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role '{user.role.value}' not authorized. Required: {[r.value for r in roles]}",
            )
        return user
    return _check_role


async def authenticate_ws(db: AsyncSession, msg: dict, ip: str | None = None) -> User:
    """WebSocket first message {"type": "auth", "token", "org"}: authenticate and
    enter the organisation (for the rest of the handler task)."""
    user = await _get_or_create_dev_user(db) if settings.DEV_MODE else await authenticate_token(msg.get("token") or "", db)
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User account is deactivated")
    org = msg.get("org")
    await bind_request(db, user, str(org) if org else None, getattr(user, "_access_key_org", None), ip)
    return user


REAUTH_SECONDS = 300


async def require_recent_auth(db: AsyncSession, user: User) -> None:
    """Before opening a terminal: a sign-in at the provider in the last minutes
    (mfa_required_for_terminal). Access keys have no interactive sign-in and
    are refused when the setting is on."""
    from app.services.settings_service import get_setting_bool
    if settings.DEV_MODE or not await get_setting_bool(db, "mfa_required_for_terminal"):
        return
    auth_time = getattr(user, "_auth_time", None)
    if not auth_time or datetime.now(timezone.utc).timestamp() - auth_time > REAUTH_SECONDS:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="reauth_required")
