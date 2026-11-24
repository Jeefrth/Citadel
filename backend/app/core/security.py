"""Credential encryption with two interchangeable backends.

- local: AES-256-GCM, key in CREDENTIAL_ENCRYPTION_KEY (legacy / no vault)
         stored as nonce(12) + ciphertext
- vault: OpenBao / Vault Transit, stored as b"vault:vN:<base64>"

decrypt_value() recognises both formats, so a database can be migrated
progressively (POST /api/admin/secrets/migrate) and keeps working during
and after the switch. New values are always written with SECRETS_BACKEND.
"""

import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import settings

VAULT_PREFIX = b"vault:v"


def is_vault_blob(encrypted: bytes | None) -> bool:
    return bool(encrypted) and bytes(encrypted).startswith(VAULT_PREFIX)


def vault_blob_version(encrypted: bytes) -> int | None:
    """Key version of a vault ciphertext ("vault:v3:..." -> 3)."""
    if not is_vault_blob(encrypted):
        return None
    try:
        return int(bytes(encrypted).split(b":", 2)[1][1:])
    except (IndexError, ValueError):
        return None


def _get_key() -> bytes:
    key_b64 = settings.CREDENTIAL_ENCRYPTION_KEY or os.environ.get("CREDENTIAL_ENCRYPTION_KEY", "")
    if not key_b64:
        raise ValueError("CREDENTIAL_ENCRYPTION_KEY is not set")
    return base64.b64decode(key_b64)


def _local_encrypt(plaintext: str) -> bytes:
    nonce = os.urandom(12)
    return nonce + AESGCM(_get_key()).encrypt(nonce, plaintext.encode(), None)


def _local_decrypt(encrypted: bytes) -> str:
    return AESGCM(_get_key()).decrypt(encrypted[:12], encrypted[12:], None).decode()


def encrypt_value(plaintext: str) -> bytes:
    if settings.SECRETS_BACKEND == "vault":
        from app.core.vault import get_vault
        return get_vault().encrypt(plaintext.encode()).encode()
    return _local_encrypt(plaintext)


def decrypt_value(encrypted: bytes) -> str:
    encrypted = bytes(encrypted)
    if is_vault_blob(encrypted):
        from app.core.vault import get_vault
        return get_vault().decrypt(encrypted.decode()).decode()
    return _local_decrypt(encrypted)


def generate_encryption_key() -> str:
    """Generate a random 256-bit key encoded in base64 (local backend only)."""
    return base64.b64encode(AESGCM.generate_key(bit_length=256)).decode()
