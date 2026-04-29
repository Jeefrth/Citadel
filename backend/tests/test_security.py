"""Tests for AES-256-GCM encryption/decryption of credentials."""

import base64
import os

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


# Generate a test key (not from config, to avoid needing .env)
TEST_KEY = base64.b64encode(AESGCM.generate_key(bit_length=256)).decode()


@pytest.fixture(autouse=True)
def _set_encryption_key(monkeypatch):
    monkeypatch.setenv("CREDENTIAL_ENCRYPTION_KEY", TEST_KEY)
    monkeypatch.setenv("DATABASE_URL", "sqlite+aiosqlite:///test.db")
    monkeypatch.setenv("AZURE_TENANT_ID", "test")
    monkeypatch.setenv("AZURE_CLIENT_ID", "test")


def test_encrypt_decrypt_roundtrip():
    from app.core.security import encrypt_value, decrypt_value

    plaintext = "my-secret-password-123!"
    encrypted = encrypt_value(plaintext)

    assert isinstance(encrypted, bytes)
    assert len(encrypted) > len(plaintext.encode())  # nonce + ciphertext + tag
    assert plaintext.encode() not in encrypted  # not stored in clear

    decrypted = decrypt_value(encrypted)
    assert decrypted == plaintext


def test_encrypt_different_outputs():
    from app.core.security import encrypt_value

    plaintext = "same-password"
    enc1 = encrypt_value(plaintext)
    enc2 = encrypt_value(plaintext)

    # Each encryption uses a random nonce, so outputs differ
    assert enc1 != enc2


def test_decrypt_tampered_data_fails():
    from app.core.security import encrypt_value, decrypt_value

    encrypted = encrypt_value("secret")
    tampered = encrypted[:-1] + bytes([encrypted[-1] ^ 0xFF])

    with pytest.raises(Exception):
        decrypt_value(tampered)


def test_encrypt_empty_string():
    from app.core.security import encrypt_value, decrypt_value

    encrypted = encrypt_value("")
    assert decrypt_value(encrypted) == ""


def test_encrypt_unicode():
    from app.core.security import encrypt_value, decrypt_value

    plaintext = "pässwörd-日本語-🔑"
    encrypted = encrypt_value(plaintext)
    assert decrypt_value(encrypted) == plaintext


def test_generate_encryption_key():
    from app.core.security import generate_encryption_key

    key = generate_encryption_key()
    decoded = base64.b64decode(key)
    assert len(decoded) == 32  # 256 bits
