"""Vault administration: status, migration of local blobs, key rotation (B10 / D1)."""

from collections import Counter

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import async_session
from app.core.security import _local_decrypt, decrypt_value, is_vault_blob, vault_blob_version
from app.models.credential import Credential
from app.models.audit_trail import RecordingStorage, SiemTarget
from app.models.governance import NotificationChannel
from app.models.operations import CloudAccount
from app.models.pam import SecretHistory

# (model, encrypted columns)
ENCRYPTED_FIELDS = [
    (Credential, ("encrypted_password", "encrypted_ssh_key")),
    (SecretHistory, ("encrypted_secret",)),
    (NotificationChannel, ("encrypted_secret",)),
    (RecordingStorage, ("encrypted_secret",)),
    (SiemTarget, ("encrypted_secret",)),
    (CloudAccount, ("encrypted_secret",)),
]


async def _iter_blobs(db: AsyncSession):
    for model, cols in ENCRYPTED_FIELDS:
        for row in (await db.execute(select(model))).scalars().all():
            for col in cols:
                value = getattr(row, col)
                if value:
                    yield row, col, bytes(value)


async def status(db: AsyncSession) -> dict:
    counts: Counter = Counter()
    async for _, _, blob in _iter_blobs(db):
        counts["local" if not is_vault_blob(blob) else f"vault:v{vault_blob_version(blob)}"] += 1

    out: dict = {
        "secrets_backend": settings.SECRETS_BACKEND,
        "ca_backend": settings.CA_BACKEND,
        "vault_addr": settings.VAULT_ADDR,
        "blobs": dict(counts),
        "local_blobs": counts.get("local", 0),
        "local_key_configured": bool(settings.CREDENTIAL_ENCRYPTION_KEY),
        "vault": None,
    }
    try:
        from app.core.vault import get_vault
        vault = get_vault()
        health = vault.health()
        info: dict = {
            "reachable": True,
            "initialized": health.get("initialized"),
            "sealed": health.get("sealed"),
            "version": health.get("version"),
        }
        if settings.SECRETS_BACKEND == "vault" and not health.get("sealed"):
            key = vault.key_info()
            info["transit_key"] = settings.VAULT_TRANSIT_KEY
            info["latest_version"] = key.get("latest_version")
            info["min_decryption_version"] = key.get("min_decryption_version")
            outdated = sum(n for k, n in counts.items()
                           if k.startswith("vault:v") and int(k[7:]) < int(key.get("latest_version", 0)))
            info["outdated_blobs"] = outdated
        out["vault"] = info
    except Exception as e:  # noqa: BLE001 - status must never fail
        out["vault"] = {"reachable": False, "error": str(e)[:300]}
    return out


async def migrate(db: AsyncSession) -> dict:
    """Re-encrypt every local AES-GCM blob with the vault transit key."""
    if settings.SECRETS_BACKEND != "vault":
        raise ValueError("SECRETS_BACKEND must be 'vault' to migrate")
    from app.core.vault import get_vault
    vault = get_vault()
    migrated = failed = 0
    errors: list[str] = []
    async for row, col, blob in _iter_blobs(db):
        if is_vault_blob(blob):
            continue
        try:
            plaintext = _local_decrypt(blob)
            setattr(row, col, vault.encrypt(plaintext.encode()).encode())
            migrated += 1
        except Exception as e:  # noqa: BLE001
            failed += 1
            errors.append(f"{type(row).__name__}.{col} {row.id}: {e}"[:200])
    await db.commit()
    return {"migrated": migrated, "failed": failed, "errors": errors[:20]}


async def rotate_key(db: AsyncSession) -> dict:
    """New transit key version, then rewrap every vault blob (no plaintext exposure)."""
    if settings.SECRETS_BACKEND != "vault":
        raise ValueError("SECRETS_BACKEND must be 'vault' to rotate the key")
    from app.core.vault import get_vault
    vault = get_vault()
    latest = vault.rotate_key()
    rewrapped = 0
    async for row, col, blob in _iter_blobs(db):
        if is_vault_blob(blob) and (vault_blob_version(blob) or 0) < latest:
            setattr(row, col, vault.rewrap(blob.decode()).encode())
            rewrapped += 1
    await db.commit()
    return {"latest_version": latest, "rewrapped": rewrapped}


async def check_all_decryptable(db: AsyncSession) -> dict:
    ok = bad = 0
    async for _, _, blob in _iter_blobs(db):
        try:
            decrypt_value(blob)
            ok += 1
        except Exception:  # noqa: BLE001
            bad += 1
    return {"decryptable": ok, "undecryptable": bad}


# ── CLI wrappers ──
async def status_standalone() -> dict:
    async with async_session() as db:
        return await status(db)


async def migrate_standalone() -> dict:
    async with async_session() as db:
        return await migrate(db)


async def rotate_key_standalone() -> dict:
    async with async_session() as db:
        return await rotate_key(db)
