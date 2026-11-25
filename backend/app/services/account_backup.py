"""Encrypted backup of the managed accounts (lot 7).

The archive holds every account Citadel manages (server, address, username,
password or private key) as JSON, encrypted with AES-256-GCM under a key
derived from the admin's passphrase (scrypt). Citadel stores the passphrase
encrypted in the vault but never shows it again: keep it outside Citadel,
it is the only way to read a backup if Citadel itself is gone.

File format (text): first line "CITADEL-ACCOUNT-BACKUP v1", second line a
JSON envelope {kdf, n, r, p, salt, nonce, ciphertext} (base64 values).
Decrypt: `python -m app.cli backup-decrypt <file>` or the snippet in
docs/vault.md (only the "cryptography" package is needed).

Destinations: download (on demand), the recording storage (local / S3 /
Azure, under backups/), e-mail attachment through the active e-mail channels.
"""

import asyncio
import base64
import hashlib
import json
import logging
import os
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tenancy import require_org_id
from app.services.settings_service import scope as settings_scope
from app.core.security import decrypt_value, encrypt_value
from app.models.audit import AuditLog
from app.models.governance import NotificationChannel
from app.models.pam import Account, AccountBackup
from app.models.server import Server
from app.models.settings import AppSetting

logger = logging.getLogger("citadel.backup")
MAGIC = "CITADEL-ACCOUNT-BACKUP v1"
PASSPHRASE_SETTING = "_backup_passphrase"
MIN_PASSPHRASE = 16
SCRYPT = {"n": 2 ** 15, "r": 8, "p": 1}


def _kdf(passphrase: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return Scrypt(salt=salt, length=32, n=n, r=r, p=p).derive(passphrase.encode())


def encrypt_archive(payload: dict, passphrase: str) -> bytes:
    salt, nonce = os.urandom(16), os.urandom(12)
    key = _kdf(passphrase, salt, **SCRYPT)
    ct = AESGCM(key).encrypt(nonce, json.dumps(payload, ensure_ascii=False).encode(), MAGIC.encode())
    env = {"kdf": "scrypt", **SCRYPT, "salt": base64.b64encode(salt).decode(),
           "nonce": base64.b64encode(nonce).decode(), "ciphertext": base64.b64encode(ct).decode()}
    return (MAGIC + "\n" + json.dumps(env) + "\n").encode()


def decrypt_archive(blob: bytes, passphrase: str) -> dict:
    head, _, rest = blob.decode().partition("\n")
    if head.strip() != MAGIC:
        raise ValueError("Not a Citadel account backup")
    env = json.loads(rest)
    key = _kdf(passphrase, base64.b64decode(env["salt"]), env["n"], env["r"], env["p"])
    try:
        plain = AESGCM(key).decrypt(base64.b64decode(env["nonce"]), base64.b64decode(env["ciphertext"]), MAGIC.encode())
    except Exception:  # noqa: BLE001 - InvalidTag: wrong passphrase or altered file
        raise ValueError("Wrong passphrase or altered file")
    return json.loads(plain)


async def get_passphrase(db: AsyncSession) -> str | None:
    row = (await db.execute(select(AppSetting).where(AppSetting.key == PASSPHRASE_SETTING, settings_scope()))).scalar_one_or_none()
    return decrypt_value(base64.b64decode(row.value)) if row else None


async def set_passphrase(db: AsyncSession, passphrase: str) -> None:
    if len(passphrase) < MIN_PASSPHRASE:
        raise ValueError(f"Phrase de passe trop courte ({MIN_PASSPHRASE} caractères au moins)")
    value = base64.b64encode(encrypt_value(passphrase)).decode()
    row = (await db.execute(select(AppSetting).where(AppSetting.key == PASSPHRASE_SETTING, settings_scope()))).scalar_one_or_none()
    if row is None:
        db.add(AppSetting(org_id=require_org_id(), key=PASSPHRASE_SETTING, value=value, description="Phrase de passe des sauvegardes (chiffrée)"))
    else:
        row.value = value


async def collect(db: AsyncSession) -> dict:
    rows = (await db.execute(select(Account, Server).join(Server, Server.id == Account.server_id)
                             .order_by(Server.name, Account.username))).all()
    accounts = []
    for a, s in rows:
        cred = a.credential
        item = {"server": s.name, "address": s.ip_address, "os": s.os_type.value, "port": s.ssh_port if s.os_type.value == "linux" else s.winrm_port,
                "username": a.username, "privileged": a.privileged, "default": a.is_default, "active": a.is_active,
                "secret_type": "certificate" if a.use_cert else ("none" if cred is None else cred.type.value)}
        if cred is not None and not a.use_cert:
            if cred.encrypted_password:
                item["password"] = decrypt_value(cred.encrypted_password)
            if cred.encrypted_ssh_key:
                item["private_key"] = decrypt_value(cred.encrypted_ssh_key)
        accounts.append(item)
    return {"format": "citadel-accounts", "version": 1, "created_at": datetime.now(timezone.utc).isoformat(),
            "accounts": accounts}


async def _email(db: AsyncSession, blob: bytes, filename: str, recipients: list[str]) -> int:
    from app.services.notifications import _smtp_send
    channels = (await db.execute(select(NotificationChannel).where(
        NotificationChannel.is_active.is_(True), NotificationChannel.type == "email"))).scalars().all()
    sent = 0
    for ch in channels:
        cfg = ch.config or {}
        to = list(dict.fromkeys(recipients or cfg.get("to") or []))
        if not to:
            continue
        msg = EmailMessage()
        msg["Subject"] = "[Citadel] Sauvegarde chiffrée des comptes"
        msg["From"] = cfg.get("sender") or cfg.get("username") or "citadel@localhost"
        msg["To"] = ", ".join(to)
        msg.set_content("Sauvegarde chiffrée des comptes gérés par Citadel, en pièce jointe.\n"
                        "Elle ne se lit qu'avec la phrase de passe des sauvegardes (voir docs/vault.md).")
        msg.add_attachment(blob, maintype="application", subtype="octet-stream", filename=filename)
        secret = decrypt_value(ch.encrypted_secret) if ch.encrypted_secret else None
        await asyncio.get_running_loop().run_in_executor(None, _smtp_send, cfg, secret, msg)
        sent += 1
    if not sent:
        raise ValueError("Aucun canal e-mail actif avec des destinataires")
    return sent


async def run_backup(db: AsyncSession, *, trigger: str, destinations: list[str], actor_id=None,
                     recipients: list[str] | None = None) -> tuple[AccountBackup, bytes | None]:
    """Build the archive and send it to each destination. Returns the history row and
    the archive (for a download)."""
    from app.services import recording_storage
    row = AccountBackup(trigger=trigger, destinations=destinations, status="running",
                        created_at=datetime.now(timezone.utc))
    db.add(row)
    await db.flush()
    blob = None
    problems = []
    try:
        passphrase = await get_passphrase(db)
        if not passphrase:
            raise ValueError("Définir d'abord la phrase de passe des sauvegardes")
        payload = await collect(db)
        blob = encrypt_archive(payload, passphrase)
        row.accounts = len(payload["accounts"])
        row.size_bytes = len(blob)
        row.sha256 = hashlib.sha256(blob).hexdigest()
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        filename = f"citadel-comptes-{stamp}.cab"
        if "storage" in destinations:
            try:
                backend = await recording_storage.active_backend(db)
                key = f"backups/{filename}"
                await backend.put(key, blob)
                row.storage_type, row.storage_key = backend.type, key
            except Exception as e:  # noqa: BLE001
                problems.append(f"stockage : {e}")
        if "email" in destinations:
            try:
                await _email(db, blob, filename, recipients or [])
            except Exception as e:  # noqa: BLE001
                problems.append(f"e-mail : {e}")
        others = [d for d in destinations if d != "download"]
        if not problems:
            row.status = "success"
        elif "download" in destinations or len(problems) < len(others):
            row.status = "partial"
        else:
            row.status = "failed"
        row.message = "; ".join(problems)[:1000] or f"{row.accounts} compte(s)"
    except Exception as e:  # noqa: BLE001
        row.status, row.message = "failed", str(e)[:1000]
        blob = None
    if actor_id is None:
        from app.services.secrets_ops import _system_user_id
        actor_id = await _system_user_id(db)
    db.add(AuditLog(user_id=actor_id, action="accounts.backup", status="success" if row.status == "success" else "failure",
                    result=f"{trigger} -> {','.join(destinations)} : {row.message}"[:500]))
    if row.status in ("failed", "partial") and trigger == "scheduled":
        from app.services.notifications import notify
        await notify(db, "backup.failed", "Échec de la sauvegarde des comptes", row.message or "", link="/settings?tab=backups",
                     level="warning")
    await db.commit()
    return row, blob


async def scheduled(db: AsyncSession, now: datetime) -> int:
    from app.services.settings_service import get_setting, get_setting_int
    days = await get_setting_int(db, "backup_interval_days")
    if days <= 0:
        return 0
    last = (await db.execute(select(AccountBackup).where(AccountBackup.trigger == "scheduled")
                             .order_by(AccountBackup.created_at.desc()).limit(1))).scalar_one_or_none()
    if last is not None and last.created_at + timedelta(days=days) > now:
        return 0
    try:
        dest = [d for d in json.loads(await get_setting(db, "backup_destinations") or "[]") if d in ("storage", "email")]
        recipients = json.loads(await get_setting(db, "backup_email_recipients") or "[]")
    except ValueError:
        dest, recipients = ["storage"], []
    await run_backup(db, trigger="scheduled", destinations=dest or ["storage"], recipients=recipients)
    return 1
