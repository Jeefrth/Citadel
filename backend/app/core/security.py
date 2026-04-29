import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import settings


def _get_key() -> bytes:
    key_b64 = settings.CREDENTIAL_ENCRYPTION_KEY
    if not key_b64:
        raise ValueError("CREDENTIAL_ENCRYPTION_KEY is not set")
    return base64.b64decode(key_b64)


def encrypt_value(plaintext: str) -> bytes:
    key = _get_key()
    aesgcm = AESGCM(key)
    nonce = os.urandom(12)
    ciphertext = aesgcm.encrypt(nonce, plaintext.encode(), None)
    return nonce + ciphertext


def decrypt_value(encrypted: bytes) -> str:
    key = _get_key()
    aesgcm = AESGCM(key)
    nonce = encrypted[:12]
    ciphertext = encrypted[12:]
    return aesgcm.decrypt(nonce, ciphertext, None).decode()


def generate_encryption_key() -> str:
    """Generate a random 256-bit key encoded in base64. Run once to create CREDENTIAL_ENCRYPTION_KEY."""
    return base64.b64encode(AESGCM.generate_key(bit_length=256)).decode()
