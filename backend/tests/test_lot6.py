"""Lot 6 helpers: devices, CSV safety, asciicast export, tag merge."""

import base64
import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.api.sessions import to_asciicast
from app.services import devices
from app.services.reports import csv_safe


@pytest.mark.parametrize("ua,label", [
    ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36", "Chrome · macOS"),
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36 Edg/131.0", "Edge · Windows"),
    ("Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0", "Firefox · Linux"),
    ("curl/8.5.0", "curl"),
    (None, "Client inconnu"),
])
def test_device_label(ua, label):
    assert devices.device_label(ua) == label


def _req(headers):
    return SimpleNamespace(headers=headers)


def test_device_key_web_and_access_key():
    assert devices.device_key_for(_req({"x-citadel-device": "a1b2c3d4-e5f6"}), None) == ("web:a1b2c3d4-e5f6", "web")
    assert devices.device_key_for(_req({"x-citadel-device": "bad id; drop"}), None) == ("web:unknown", "web")
    assert devices.device_key_for(_req({"x-citadel-device": "a1b2c3d4"}), "abcd1234") == ("key:abcd1234", "access_key")


async def test_revoked_device_is_refused_from_cache(monkeypatch):
    async def cached(_k):
        return "revoked"
    monkeypatch.setattr(devices, "_cache_get", cached)
    with pytest.raises(Exception) as e:
        await devices.touch(None, SimpleNamespace(id="u"), _req({"x-citadel-device": "a1b2c3d4"}), "1.2.3.4")
    assert e.value.status_code == 401 and e.value.detail == devices.REVOKED_DETAIL


@pytest.mark.parametrize("value,out", [("=HYPERLINK(1)", "'=HYPERLINK(1)"), ("@SUM", "'@SUM"), ("alice", "alice"), (None, ""), (3, "3")])
def test_csv_safe(value, out):
    assert csv_safe(value) == out


def test_asciicast_export():
    rec = SimpleNamespace(started_at=datetime(2026, 11, 25, tzinfo=timezone.utc), user_name="alice",
                          server_name="web-01", account="root")
    events = [{"t": 0, "type": "o", "data": base64.b64encode(b"$ ").decode()},
              {"t": 1500, "type": "i", "data": base64.b64encode(b"id\r").decode()},
              {"t": 1600, "type": "x", "data": ""}]
    lines = to_asciicast(events, rec).strip().split("\n")
    header = json.loads(lines[0])
    assert header["version"] == 2 and "alice" in header["title"]
    assert json.loads(lines[1]) == [0.0, "o", "$ "]
    assert json.loads(lines[2]) == [1.5, "i", "id\r"]
    assert len(lines) == 3
