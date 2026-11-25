"""Recette 25/11: B1 (key devices), B2 (refused file ops audited), B3 (my sign-ins)."""

import inspect
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api import identity, operations
from app.services import devices, sftp


async def test_b2_refused_file_operation_is_audited(monkeypatch):
    audited = []

    async def ctx(*a, **k):
        return SimpleNamespace(name="srv"), None, SimpleNamespace(label="deploy")

    async def audit(user, server, action, path, ip, result="", status="success"):
        audited.append((action, status, result))

    class _Sftp:
        async def __aenter__(self): return object()
        async def __aexit__(self, *a): return False

    async def refuse(_client):
        raise sftp.SftpError("Dossier non vide : seuls les dossiers vides peuvent être supprimés")

    monkeypatch.setattr(operations, "_file_context", ctx)
    monkeypatch.setattr(operations, "_audit_file", audit)
    monkeypatch.setattr(operations.sftp, "open_sftp", lambda s, a: _Sftp())
    req = SimpleNamespace(state=SimpleNamespace(client_ip="10.0.0.1"))
    with pytest.raises(HTTPException) as e:
        await operations._write_op(None, SimpleNamespace(), req, "id", SimpleNamespace(path="/x", account_id=None, virtual_account=None),
                                   "file.delete", refuse)
    assert e.value.status_code == 400 and "Dossier non vide" in e.value.detail
    assert audited == [("file.delete", "failure", "account=deploy Dossier non vide : seuls les dossiers vides peuvent être supprimés")]


def test_b3_mine_param_restricts_to_own_sign_ins():
    src = inspect.getsource(identity.login_events)
    assert "mine" in inspect.signature(identity.login_events).parameters
    assert "if mine or not has_perm(user, \"audit\")" in src


async def test_b1_close_key_devices_marks_them(monkeypatch):
    dev = SimpleNamespace(user_id="u", device_key="key:abcd", revoked_at=None, revoked_by=None)

    class _Db:
        async def execute(self, *_):
            return SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: [dev]))

    dropped = []

    async def drop(k):
        dropped.append(k)

    monkeypatch.setattr(devices, "_cache_drop", drop)
    await devices.close_key_devices(_Db(), ["abcd"], "clé révoquée")
    assert dev.revoked_at is not None and dev.revoked_by == "clé révoquée" and dropped == ["citadel:dev:u:key:abcd"]
