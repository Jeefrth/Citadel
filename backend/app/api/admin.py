import uuid
import json

from fastapi import APIRouter, Depends, HTTPException, status, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user, require_role
from app.core.database import get_db
from app.models.user import User
from app.models.base import UserRole
from app.models.metric import AlertRule
from app.services import settings_service, ca_service
from app.schemas.user import UserRead, UserUpdate
from app.services.roles import apply_user_update

router = APIRouter()


# ── Settings ─────────────────────────────────────────────


class SettingUpdate(BaseModel):
    value: str


class SettingResponse(BaseModel):
    key: str
    value: str
    description: str
    is_default: bool


@router.get("/settings", response_model=dict[str, SettingResponse])
async def get_all_settings(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    """Get all application settings."""
    all_settings = await settings_service.get_all_settings(db)
    return {
        key: SettingResponse(key=key, **meta)
        for key, meta in all_settings.items()
    }


@router.put("/settings/{key}")
async def update_setting(
    key: str,
    body: SettingUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    """Update a setting value."""
    if key not in settings_service.DEFAULTS:
        raise HTTPException(status_code=404, detail=f"Unknown setting: {key}")

    # Validate JSON settings
    if key in ("ip_allowlist", "command_blocklist"):
        try:
            json.loads(body.value)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid JSON value")

    if key == "ip_allowlist":
        from app.services.org_policy import ip_allowed, parse_allowlist
        entries = json.loads(body.value)
        if not isinstance(entries, list):
            raise HTTPException(status_code=400, detail="Liste attendue")
        nets = parse_allowlist(entries)
        if len(nets) != len([e for e in entries if str(e).strip()]):
            raise HTTPException(status_code=400, detail="Adresse ou plage invalide dans la liste")
        ip = getattr(request.state, "client_ip", None)
        if nets and not ip_allowed(ip, nets) and not user.is_platform_admin:
            raise HTTPException(status_code=400, detail=f"Votre adresse actuelle ({ip}) n'est pas dans la liste : "
                                                        "vous perdriez l'accès à l'organisation")
        body.value = json.dumps([str(n) for n in nets])

    int_ranges = {"rate_limit_requests": (0, 100000), "rate_limit_window_seconds": (1, 3600), "idle_timeout_minutes": (1, 1440),
                  "default_cert_validity_minutes": (1, 1440), "max_cert_validity_minutes": (1, 1440),
                  "min_cert_validity_minutes": (1, 1440)}
    if key in int_ranges:
        lo, hi = int_ranges[key]
        try:
            v = int(body.value)
        except ValueError:
            raise HTTPException(status_code=400, detail="Nombre entier attendu")
        if not lo <= v <= hi:
            raise HTTPException(status_code=400, detail=f"Valeur entre {lo} et {hi}")
        if key == "rate_limit_requests" and 0 < v < 30:
            raise HTTPException(status_code=400, detail="Au moins 30 requêtes (0 = pas de limite) : l'interface en fait plusieurs par page")

    if key == "data_masking_rules":
        from app.services import masking
        try:
            body.value = json.dumps(masking.validate_rules(json.loads(body.value)), ensure_ascii=False)
        except (json.JSONDecodeError, ValueError) as e:
            raise HTTPException(status_code=400, detail=str(e))

    await settings_service.set_setting(db, key, body.value)
    return {"key": key, "value": body.value}


@router.get("/masking/presets")
async def masking_presets(_: User = Depends(require_role(UserRole.ADMIN))):
    from app.services import masking
    return masking.PRESETS


class MaskTest(BaseModel):
    rules: list
    sample: str


@router.post("/masking/test")
async def masking_test(body: MaskTest, _: User = Depends(require_role(UserRole.ADMIN))):
    from app.services import masking
    try:
        rules = masking.validate_rules(body.rules)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    m = masking.build(rules)
    return {"result": m.apply(body.sample[:20000].encode()).decode(errors="replace"), "hits": m.hits}


@router.post("/settings/reset/{key}")
async def reset_setting(
    key: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    """Reset a setting to its default value."""
    if key not in settings_service.DEFAULTS:
        raise HTTPException(status_code=404, detail=f"Unknown setting: {key}")

    default_value = settings_service.DEFAULTS[key]["value"]
    await settings_service.set_setting(db, key, default_value)
    return {"key": key, "value": default_value}


# ── Users Management ─────────────────────────────────────


@router.get("/users", response_model=list[UserRead])
async def list_users(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    from app.services.roles import list_members
    return await list_members(db)


@router.patch("/users/{user_id}", response_model=UserRead)
async def update_user(
    user_id: uuid.UUID,
    data: UserUpdate,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_role(UserRole.ADMIN)),
):
    from app.services.roles import get_member
    user, _ = await get_member(db, user_id)
    return await apply_user_update(db, user, data, actor)


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")

    from app.services.roles import remove_member
    await remove_member(db, user_id, current_user)


# ── CA Info ──────────────────────────────────────────────


@router.get("/ca/info")
async def get_ca_info(
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    """Get CA certificate information."""
    pub_key = ca_service.get_ca_public_key()
    return {
        "public_key": pub_key,
        "key_path": str(ca_service.CA_DIR),
        "algorithm": "Ed25519",
    }


# ── System ───────────────────────────────────────────────


@router.get("/system")
async def get_system_info(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    """Get system overview."""
    from app.models.server import Server
    from app.models.session_recording import SessionRecording
    from app.models.audit import AuditLog
    from sqlalchemy import func

    server_count = (await db.execute(select(func.count(Server.id)))).scalar_one()
    from app.services.members import member_ids_subquery
    user_count = (await db.execute(select(func.count(User.id)).where(User.id.in_(member_ids_subquery())))).scalar_one()
    session_count = (await db.execute(select(func.count(SessionRecording.id)))).scalar_one()
    audit_count = (await db.execute(select(func.count(AuditLog.id)))).scalar_one()
    alert_count = (await db.execute(select(func.count(AlertRule.id)))).scalar_one()

    return {
        "version": "0.1.0",
        "servers": server_count,
        "users": user_count,
        "sessions": session_count,
        "audit_entries": audit_count,
        "alert_rules": alert_count,
    }
