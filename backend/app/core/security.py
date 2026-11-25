"""Credential encryption with two interchangeable backends.

- local: AES-256-GCM, key in CREDENTIAL_ENCRYPTION_KEY (legacy / no vault)
         stored as nonce(12) + ciphertext
- vault: OpenBao / Vault Transit, stored as b"vault:vN:<base64>"

decrypt_value() recognises both formats, so a database can be migrated
progressively (POST /api/admin/secrets/migrate) and keeps working during
and after the switch. New values are always written with SECRETS_BACKEND.

Organisations (SaaS phase 1): an organisation other than the default one has
its own key (Organization.transit_key, a Transit key in the vault, or a key
derived from the local one). Its blobs are prefixed b"okey:<key>|". Inside an
organisation, decrypting a blob of another key is refused: a secret copied
from one organisation to another stays unreadable.
"""

import base64
import os
import re

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.core import tenancy
from app.core.config import settings

VAULT_PREFIX = b"vault:v"
ORG_PREFIX = b"okey:"
ORG_KEY_PREFIX = "citadel-org-"
_KEY_RE = re.compile(r"citadel-org-[0-9a-f]{32}")   # the name goes into a vault path


class KeyMismatch(ValueError):
    """Blob encrypted with the key of another organisation."""


def split_blob(encrypted: bytes) -> tuple[str | None, bytes]:
    """b"okey:<key>|<inner>" -> ("<key>", inner); a default-key blob -> (None, blob)."""
    b = bytes(encrypted)
    if b.startswith(ORG_PREFIX):
        key, sep, inner = b[len(ORG_PREFIX):].partition(b"|")
        if not sep or not _KEY_RE.fullmatch(key.decode(errors="replace")):
            raise ValueError("Malformed organisation blob")
        return key.decode(), inner
    return None, b


def join_blob(key: str | None, inner: bytes) -> bytes:
    return inner if key is None else ORG_PREFIX + key.encode() + b"|" + inner


def is_vault_blob(encrypted: bytes | None) -> bool:
    return bool(encrypted) and split_blob(encrypted)[1].startswith(VAULT_PREFIX)


def vault_blob_version(encrypted: bytes) -> int | None:
    """Key version of a vault ciphertext ("vault:v3:..." -> 3)."""
    if not is_vault_blob(encrypted):
        return None
    try:
        return int(split_blob(encrypted)[1].split(b":", 2)[1][1:])
    except (IndexError, ValueError):
        return None


def current_key() -> str | None:
    """Key of the organisation in context; None = default key (default
    organisation, platform code)."""
    ctx = tenancy.current()
    return ctx.transit_key if ctx is not None and not ctx.bypass else None


def _check_key(key: str | None) -> None:
    ctx = tenancy.current()
    if ctx is None or ctx.bypass:
        return   # platform code (host key, CLI over every organisation)
    if key != ctx.transit_key:
        raise KeyMismatch("Secret of another organisation")


def _get_key(key: str | None = None) -> bytes:
    key_b64 = settings.CREDENTIAL_ENCRYPTION_KEY or os.environ.get("CREDENTIAL_ENCRYPTION_KEY", "")
    if not key_b64:
        raise ValueError("CREDENTIAL_ENCRYPTION_KEY is not set")
    master = base64.b64decode(key_b64)
    if key is None:
        return master
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=b"citadel-org-key:" + key.encode()).derive(master)


def _local_encrypt(plaintext: str, key: str | None = None) -> bytes:
    nonce = os.urandom(12)
    return nonce + AESGCM(_get_key(key)).encrypt(nonce, plaintext.encode(), None)


def _local_decrypt(encrypted: bytes, key: str | None = None) -> str:
    return AESGCM(_get_key(key)).decrypt(encrypted[:12], encrypted[12:], None).decode()


def encrypt_value(plaintext: str) -> bytes:
    key = current_key()
    if settings.SECRETS_BACKEND == "vault":
        from app.core.vault import get_vault
        return join_blob(key, get_vault().encrypt(plaintext.encode(), key=key).encode())
    return join_blob(key, _local_encrypt(plaintext, key))


def decrypt_value(encrypted: bytes) -> str:
    key, inner = split_blob(encrypted)
    _check_key(key)
    if inner.startswith(VAULT_PREFIX):
        from app.core.vault import get_vault
        return get_vault().decrypt(inner.decode(), key=key).decode()
    return _local_decrypt(inner, key)


def new_org_key_name(org_id) -> str:
    return f"{ORG_KEY_PREFIX}{str(org_id).replace('-', '')}"


def create_org_key(name: str) -> None:
    """Create the Transit key of a new organisation (local backend: derived, nothing to do)."""
    if settings.SECRETS_BACKEND == "vault":
        from app.core.vault import get_vault
        get_vault().create_key(name)


def generate_encryption_key() -> str:
    """Generate a random 256-bit key encoded in base64 (local backend only)."""
    return base64.b64encode(AESGCM.generate_key(bit_length=256)).decode()
