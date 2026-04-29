from datetime import datetime, timezone

import httpx
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from sqlalchemy import select
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

    # Try both audience formats: raw client ID and api:// URI
    payload = None
    last_error = None
    for aud in [f"api://{settings.AZURE_CLIENT_ID}", settings.AZURE_CLIENT_ID]:
        try:
            payload = jwt.decode(
                token,
                rsa_key,
                algorithms=["RS256"],
                audience=aud,
                issuer=settings.azure_issuer,
            )
            break
        except JWTError as e:
            last_error = e
            continue

    if payload is None:
        # Try without issuer validation as fallback (v1 vs v2 tokens)
        try:
            payload = jwt.decode(
                token,
                rsa_key,
                algorithms=["RS256"],
                audience=f"api://{settings.AZURE_CLIENT_ID}",
                options={"verify_iss": False},
            )
        except JWTError as e:
            last_error = e

    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Token validation failed: {e}",
        )

    return payload


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
        user = User(
            entra_object_id=oid,
            email=claims.get("preferred_username", claims.get("email", "")),
            display_name=claims.get("name", "Unknown"),
            role=UserRole.VIEWER,
            is_active=True,
        )
        db.add(user)

    user.last_login = datetime.now(timezone.utc)
    user.display_name = claims.get("name", user.display_name)
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


async def get_current_user(
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

    claims = await _validate_token(credentials.credentials)
    user = await _sync_user(claims, db)

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account is deactivated",
        )

    return user


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
