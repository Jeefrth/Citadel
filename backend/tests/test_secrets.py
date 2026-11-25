"""Unit tests for the secrets lifecycle (no vault, no DB, no SSH)."""

import base64
import json

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.services.secrets_ops import (
    PASSWORD_SYMBOLS, generate_password, parse_linux_accounts, parse_windows_accounts,
)

TEST_KEY = base64.b64encode(AESGCM.generate_key(bit_length=256)).decode()


def test_generated_passwords_are_complex_and_shell_safe():
    for _ in range(200):
        pw = generate_password()
        assert len(pw) == 24
        assert any(c.islower() for c in pw) and any(c.isupper() for c in pw)
        assert any(c.isdigit() for c in pw) and any(c in PASSWORD_SYMBOLS for c in pw)
        assert not set(pw) & set("'\"\\ `$:\n")  # chpasswd uses ':' as separator
    with pytest.raises(ValueError):
        generate_password(8)


LINUX_OUT = """root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
alice:x:1000:1000::/home/alice:/bin/bash
bob:x:1001:1001::/home/bob:/bin/zsh
svcapp:x:998:998::/home/svcapp:/usr/sbin/nologin
locked:x:1002:1002::/home/locked:/bin/false
nobody:x:65534:65534:nobody:/nonexistent:/bin/sh
---GROUPS---
sudo:x:27:bob
wheel:x:10:
---LASTLOG---
root             pts/0    10.0.0.5         Tue Nov 24 17:00:00 +0000 2026
alice                                      **Never logged in**
"""


def test_parse_linux_keeps_interactive_accounts_only():
    accounts = {a["username"]: a for a in parse_linux_accounts(LINUX_OUT)}
    assert set(accounts) == {"root", "alice", "bob"}
    assert accounts["root"]["privileged"] and accounts["bob"]["privileged"]
    assert not accounts["alice"]["privileged"]
    assert accounts["root"]["last_login"].startswith("pts/0")
    assert accounts["alice"]["last_login"] is None


def test_parse_windows_single_and_list():
    one = json.dumps({"name": "Administrator", "sid": "S-1-5-21-1-500", "enabled": False, "last": None, "admin": True})
    assert parse_windows_accounts(one)[0]["privileged"] is True
    many = json.dumps([
        {"name": "Administrator", "sid": "S-1", "enabled": True, "last": "2026-11-01T10:00:00", "admin": True},
        {"name": "jdoe", "sid": "S-2", "enabled": True, "last": None, "admin": False},
    ])
    parsed = parse_windows_accounts(many)
    assert [a["username"] for a in parsed] == ["Administrator", "jdoe"]
    assert parsed[0]["last_login"] == "2026-11-01T10:00:00"
    assert parse_windows_accounts("") == []


class FakeVault:
    def encrypt(self, plaintext: bytes, key: str | None = None) -> str:
        return "vault:v3:" + base64.b64encode(plaintext[::-1]).decode()

    def decrypt(self, ciphertext: str, key: str | None = None) -> bytes:
        return base64.b64decode(ciphertext.split(":", 2)[2])[::-1]


@pytest.fixture
def security(monkeypatch):
    monkeypatch.setenv("CREDENTIAL_ENCRYPTION_KEY", TEST_KEY)
    from app.core import security as sec
    monkeypatch.setattr(sec.settings, "CREDENTIAL_ENCRYPTION_KEY", TEST_KEY)
    monkeypatch.setattr("app.core.vault.get_vault", lambda: FakeVault())
    return sec


def test_vault_backend_writes_vault_blobs_and_reads_both(security, monkeypatch):
    monkeypatch.setattr(security.settings, "SECRETS_BACKEND", "local")
    legacy = security.encrypt_value("legacy")
    assert not security.is_vault_blob(legacy)
    monkeypatch.setattr(security.settings, "SECRETS_BACKEND", "vault")
    new = security.encrypt_value("fresh")
    assert security.is_vault_blob(new) and security.vault_blob_version(new) == 3
    # Mixed database during migration: both formats decrypt
    assert security.decrypt_value(legacy) == "legacy"
    assert security.decrypt_value(new) == "fresh"


def test_vault_blob_version_parsing(security):
    assert security.vault_blob_version(b"vault:v12:abc") == 12
    assert security.vault_blob_version(b"\x00\x01raw") is None


def test_issuers_are_pinned_to_tenant(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "AZURE_TENANT_ID", "tenant-a")
    assert settings.azure_issuers == [
        "https://login.microsoftonline.com/tenant-a/v2.0",
        "https://sts.windows.net/tenant-a/",
    ]
