import hashlib
import hmac
from datetime import datetime, timezone

import httpx
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.models.user import User
from app.models.base import UserRole

security = HTTPBearer(auto_error=False)

_jwks_cache: dict | None = None


async def _get_jwks() -> dict:
    global _jwks_cache
    if _jwks_cache is None:
        async with httpx.AsyncClient() as client:
            resp = await client.get(settings.azure_jwks_url)
            resp.raise_for_status()
            _jwks_cache = resp.json()
    return _jwks_cache


def _clear_jwks_cache():
    global _jwks_cache
    _jwks_cache = None


async def _validate_token(token: str) -> dict:
    """Validate an Entra ID access token and return its claims."""
    jwks = await _get_jwks()

    try:
        unverified_header = jwt.get_unverified_header(token)
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token header",
        )

    # Find the matching key
    rsa_key = None
    for key in jwks.get("keys", []):
        if key["kid"] == unverified_header.get("kid"):
            rsa_key = key
            break

    if rsa_key is None:
        # Key not found, maybe keys rotated — clear cache and retry once
        _clear_jwks_cache()
        jwks = await _get_jwks()
        for key in jwks.get("keys", []):
            if key["kid"] == unverified_header.get("kid"):
                rsa_key = key
                break

    if rsa_key is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unable to find matching signing key",
        )

    # Audience: api:// URI or raw client ID. Issuer: v2 or v1 format of OUR
    # tenant only (Entra signing keys are shared across tenants, so the
    # issuer check is what pins tokens to this tenant).
    payload = None
    last_error = None
    for aud in [f"api://{settings.AZURE_CLIENT_ID}", settings.AZURE_CLIENT_ID]:
        try:
            payload = jwt.decode(token, rsa_key, algorithms=["RS256"], audience=aud,
                                 options={"verify_iss": False})
        except JWTError as e:
            last_error = e
            continue
        if payload.get("iss") not in settings.azure_issuers:
            last_error = JWTError(f"Untrusted issuer: {payload.get('iss')}")
            payload = None
            continue
        if payload.get("tid") and payload["tid"] != settings.AZURE_TENANT_ID:
            last_error = JWTError("Token from another tenant")
            payload = None
            continue
        break

    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Token validation failed: {last_error}",
        )

    return payload


def _claim_email(claims: dict) -> str:
    # v2 access tokens often carry "upn" but not "preferred_username"
    for k in ("preferred_username", "upn", "email", "unique_name"):
        v = claims.get(k)
        if v and "@" in v:
            return v
    return ""


async def _sync_user(claims: dict, db: AsyncSession) -> User:
    """Find or create local user from Entra ID token claims."""
    oid = claims.get("oid")
    if not oid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token missing 'oid' claim",
        )

    result = await db.execute(select(User).where(User.entra_object_id == oid))
    user = result.scalar_one_or_none()

    if user is None:
        # First real user (non-dev) gets admin role automatically
        existing_count = await db.execute(
            select(func.count(User.id)).where(User.entra_object_id != "dev-mode-user-00000000")
        )
        is_first_user = existing_count.scalar_one() == 0

        user = User(
            entra_object_id=oid,
            email=_claim_email(claims),
            display_name=claims.get("name", "Unknown"),
            role=UserRole.ADMIN if is_first_user else UserRole.VIEWER,
            is_active=True,
        )
        db.add(user)

    user.last_login = datetime.now(timezone.utc)
    user.display_name = claims.get("name", user.display_name)
    if not user.email:
        user.email = _claim_email(claims)
    await db.commit()
    await db.refresh(user)
    return user


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
            role=UserRole.ADMIN,
            is_active=True,
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)

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


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> User:
    """FastAPI dependency: validate token and return current user."""
    from app.core.config import settings

    if settings.DEV_MODE:
        return await _get_or_create_dev_user(db)

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
    method = "access_key" if getattr(user, "_via_access_key", False) else "entra"

    if not user.is_active:
        await devices.record_denied(db, user, ip, "compte désactivé", method, request.headers.get("user-agent"))
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account is deactivated",
        )

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
    key = (await db.execute(select(AccessKey).where(AccessKey.prefix == parts[1]))).scalar_one_or_none()
    now = datetime.now(timezone.utc)
    if (
        key is None
        or not key.is_active
        or not hmac.compare_digest(key.key_hash, hash_access_key(token))
        or (key.expires_at is not None and key.expires_at < now)
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired access key")
    key.last_used_at = now
    user = key.user
    await db.commit()
    user._via_access_key = True  # lets sensitive endpoints refuse token-on-token
    user._access_key_prefix = key.prefix
    return user


async def authenticate_token(token: str, db: AsyncSession) -> User:
    """Authenticate either an Entra ID access token or a Citadel access key."""
    if token.startswith(ACCESS_KEY_PREFIX):
        return await _authenticate_access_key(token, db)
    claims = await _validate_token(token)
    return await _sync_user(claims, db)


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
