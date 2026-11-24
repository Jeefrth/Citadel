"""Unit tests for audit helpers (SIEM formats, local recording storage)."""

import asyncio
import gzip
import hashlib
import json

import pytest

from app.services import siem
from app.services.recording_storage import IntegrityError, LocalBackend, StorageError

EVENT = {
    "stream": "commands", "id": "6b1e", "timestamp": "2026-11-24T19:04:00+00:00",
    "action": "command.denied", "status": "failure", "user": "Op|O", "account": "root",
    "server": "web=1", "command": "rm -rf /\nx", "rule": "No rm", "session_id": None, "src_ip": "10.0.0.5",
}


def test_cef_header_and_extension_escaping():
    cef = siem.to_cef(EVENT)
    assert cef.startswith("CEF:0|Citadel|Citadel PAM|")
    assert "|command.denied|command.denied|7|" in cef        # severity of a denial
    assert "suser=Op|O" in cef                                # '|' is fine in extensions
    assert "dhost=web\\=1" in cef                             # '=' escaped in extensions
    assert "\n" not in cef                                    # newlines flattened
    assert "cs1Label=command cs1=rm -rf / x" in cef
    assert "cs3Label" not in cef                              # no label without a value


def test_syslog_line_is_rfc5424_with_authpriv_facility():
    line = siem.to_syslog(EVENT, "json").decode()
    assert line.startswith("<84>1 2026-11-24T19:04:00+00:00 ")   # authpriv(10)*8 + warning(4)
    assert " citadel - command.denied - " in line
    assert json.loads(line.split(" - ", 2)[2])["command"] == EVENT["command"]


def test_hec_body_one_envelope_per_event():
    body, ctype = siem.http_body([EVENT, EVENT], "hec", {"sourcetype": "citadel:audit", "index": "pam"})
    lines = body.decode().split("\n")
    assert ctype == "application/json" and len(lines) == 2
    env = json.loads(lines[0])
    assert env["sourcetype"] == "citadel:audit" and env["index"] == "pam" and env["event"]["id"] == "6b1e"


def test_local_storage_rejects_path_traversal(tmp_path):
    backend = LocalBackend(str(tmp_path))
    with pytest.raises(StorageError):
        asyncio.run(backend.put("../../etc/evil", b"x"))


def test_local_storage_roundtrip_and_integrity(tmp_path, monkeypatch):
    from app.services import recording_storage as rs

    backend = LocalBackend(str(tmp_path))

    async def _active(_db):
        return backend

    async def _for(_db, _type):
        return backend

    monkeypatch.setattr(rs, "active_backend", _active)
    monkeypatch.setattr(rs, "backend_for", _for)
    stored = asyncio.run(rs.store(None, "ssh/2026/a.json.gz", b'[{"t":0}]'))
    assert stored.sha256 == hashlib.sha256((tmp_path / "store/ssh/2026/a.json.gz").read_bytes()).hexdigest()
    assert asyncio.run(rs.load(None, "local", stored.key, stored.sha256)) == b'[{"t":0}]'
    path = tmp_path / "store/ssh/2026/a.json.gz"
    path.write_bytes(gzip.compress(b'[{"t":1}]'))                 # tampered
    with pytest.raises(IntegrityError):
        asyncio.run(rs.load(None, "local", stored.key, stored.sha256))
