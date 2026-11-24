"""Dynamic application settings stored in the database.

Settings are loaded from DB with fallback to defaults.
Changes take effect immediately (no restart needed).
"""

import json
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.settings import AppSetting

# Default settings with descriptions
DEFAULTS = {
    "data_masking_rules": {
        "value": "[]",
        "description": "Masquage dans la sortie des terminaux : liste JSON de règles {name, pattern, replacement, enabled}.",
    },
    "access_expiry_notice_days": {
        "value": "3",
        "description": "Prévenir les personnes concernées et les admins ce nombre de jours avant la fin d'une règle d'accès. 0 : jamais.",
    },
    # Security
    "idle_timeout_minutes": {
        "value": "30",
        "description": "Une session sans activité est fermée après ce délai.",
    },
    "rate_limit_requests": {
        "value": "200",
        "description": "Nombre maximal de requêtes par adresse IP sur la fenêtre ci-dessous.",
    },
    "rate_limit_window_seconds": {
        "value": "60",
        "description": "Durée de la fenêtre de comptage des requêtes.",
    },
    "mfa_required_for_terminal": {
        "value": "true",
        "description": "Redemande l'authentification forte avant chaque ouverture de session.",
    },
    "default_cert_validity_minutes": {
        "value": "480",
        "description": "Durée proposée par défaut pour un certificat éphémère.",
    },
    "max_cert_validity_minutes": {
        "value": "1440",
        "description": "Durée maximale qu'un utilisateur peut choisir.",
    },
    "min_cert_validity_minutes": {
        "value": "5",
        "description": "Durée minimale qu'un utilisateur peut choisir.",
    },

    # IP Allowlist (empty = allow all)
    "ip_allowlist": {
        "value": "[]",
        "description": "Adresses ou plages autorisées à joindre Citadel. Vide : toutes.",
    },

    # Command Filter
    "command_blocklist": {
        "value": json.dumps([
            "rm\\s+(-[a-zA-Z]*f[a-zA-Z]*\\s+)?/\\s*$",
            "rm\\s+-[a-zA-Z]*f[a-zA-Z]*\\s+/",
            "mkfs\\.",
            "dd\\s+.*of=/dev/[sh]d",
            ":\\s*\\(\\)\\s*\\{\\s*:\\|\\s*:\\s*&\\s*\\}\\s*;",
            "shutdown\\s",
            "reboot\\s*$",
            "init\\s+0",
            "halt\\s*$",
            "poweroff",
            ">\\s*/dev/[sh]d",
            "chmod\\s+(-[a-zA-Z]+\\s+)?777\\s+/",
            "chown\\s+.*\\s+/\\s*$",
            "wget\\s+.*\\|\\s*sh",
            "curl\\s+.*\\|\\s*sh",
            "curl\\s+.*\\|\\s*bash",
        ]),
        "description": "Expressions régulières refusées partout, avant les ACL de commandes.",
    },
    "command_filter_enabled": {
        "value": "true",
        "description": "Applique la liste de blocage aux commandes et au terminal.",
    },

    # Session Recording
    "session_recording_enabled": {
        "value": "true",
        "description": "Enregistre les sessions SSH et RDP pour pouvoir les rejouer.",
    },
    "max_session_recordings": {
        "value": "1000",
        "description": "Au-delà, les plus anciens enregistrements sont supprimés.",
    },

    # Audit (lot 4)
    "recording_retention_days": {
        "value": "0",
        "description": "Les enregistrements plus anciens sont supprimés. 0 : conservation illimitée.",
    },
    "command_log_retention_days": {
        "value": "0",
        "description": "Les entrées plus anciennes du journal sont supprimées. 0 : conservation illimitée.",
    },
    "max_transfer_mb": {
        "value": "500",
        "description": "Taille maximale d'un fichier transféré par le navigateur (Mo).",
    },
    "notify_user_on_monitor": {
        "value": "true",
        "description": "Prévient l'utilisateur quand un administrateur observe sa session.",
    },
}


async def get_setting(db: AsyncSession, key: str) -> str:
    """Get a setting value from DB, falling back to default."""
    result = await db.execute(
        select(AppSetting).where(AppSetting.key == key)
    )
    setting = result.scalar_one_or_none()
    if setting:
        return setting.value

    default = DEFAULTS.get(key)
    if default:
        return default["value"]

    return ""


async def get_setting_int(db: AsyncSession, key: str) -> int:
    value = await get_setting(db, key)
    try:
        return int(value)
    except (ValueError, TypeError):
        return int(DEFAULTS.get(key, {}).get("value", "0"))


async def get_setting_bool(db: AsyncSession, key: str) -> bool:
    value = await get_setting(db, key)
    return value.lower() in ("true", "1", "yes")


async def get_setting_json(db: AsyncSession, key: str) -> list | dict:
    value = await get_setting(db, key)
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        default = DEFAULTS.get(key, {}).get("value", "[]")
        return json.loads(default)


async def set_setting(db: AsyncSession, key: str, value: str):
    """Set a setting value in DB."""
    result = await db.execute(
        select(AppSetting).where(AppSetting.key == key)
    )
    setting = result.scalar_one_or_none()

    if setting:
        setting.value = value
    else:
        desc = DEFAULTS.get(key, {}).get("description", "")
        setting = AppSetting(key=key, value=value, description=desc)
        db.add(setting)

    await db.commit()


async def get_all_settings(db: AsyncSession) -> dict:
    """Get all settings (DB values merged with defaults)."""
    result = await db.execute(select(AppSetting))
    db_settings = {s.key: s.value for s in result.scalars().all()}

    all_settings = {}
    for key, meta in DEFAULTS.items():
        all_settings[key] = {
            "value": db_settings.get(key, meta["value"]),
            "description": meta["description"],
            "is_default": key not in db_settings,
        }

    return all_settings
