"""Unit tests for governance helpers (no DB)."""

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.core import governance as gov
from app.websocket.line_tracker import LineTracker


def _feed(t: LineTracker, out: bytes = b"", inp: bytes = b""):
    if inp:
        t.feed(inp)
    if out:
        t.on_output(out)


def test_plain_typing_with_backspace_and_ctrl_u():
    t = LineTracker()
    t.on_output(b"user@h:~$ ")
    _feed(t, inp=b"lss\x7f -la")
    assert t.take_line() == "ls -la"
    _feed(t, inp=b"rm -rf /\x15echo ok")
    assert t.take_line() == "echo ok"


def test_history_recall_and_mid_line_edit_read_from_echo():
    t = LineTracker()
    t.on_output(b"\x1b]0;alice@h: ~\x07alice@h:~$ ")
    _feed(t, inp=b"\x1b[A\x1b[A", out=b"echo bb\x08\x08AAA_TOKEN > /tmp/z1")
    _feed(t, inp=b"\x1b[D\x1b[D\x1b[D", out=b"\x08\x08\x08")
    _feed(t, inp=b"2", out=b"\x1b[1@2")
    assert t.take_line() == "echo AAA_TOKEN > /tmp2/z1"


def test_shorter_history_entry_erases_tail():
    t = LineTracker()
    t.on_output(b"$ ")
    _feed(t, inp=b"\x1b[A", out=b"echo a-very-long-command")
    _feed(t, inp=b"\x1b[A", out=b"\x08" * 19 + b"ls\x1b[K")
    assert t.take_line() == "echo ls"


def test_prompt_containing_marker_inside_command():
    t = LineTracker()
    t.on_output(b"root@h:~# ")
    _feed(t, inp=b"\t", out=b"")          # uncertain mode
    t.on_output(b"echo '# not a prompt'")
    assert t.take_line() == "echo '# not a prompt'"


def test_full_screen_apps_are_ignored():
    t = LineTracker()
    t.on_output(b"$ ")
    t.on_output(b"\x1b[?1049h")
    _feed(t, inp=b":wq")
    assert t.take_line() is None
    t.on_output(b"\x1b[?1049l$ ")
    _feed(t, inp=b"id")
    assert t.take_line() == "id"


def test_split_on_enter():
    assert LineTracker().split(b"a\rb\rc") == [(b"a", True), (b"b", True), (b"c", False)]


@pytest.mark.parametrize("hour,minute,weekday_offset,expected", [
    (23, 30, 0, True),   # Monday 23:30 inside 22:00-06:00 (Monday window)
    (5, 0, 1, True),     # Tuesday 05:00 belongs to Monday night
    (12, 0, 0, False),
])
def test_overnight_time_window(monkeypatch, hour, minute, weekday_offset, expected):
    monkeypatch.setattr(gov.settings, "TIMEZONE", "UTC")
    now = datetime(2026, 11, 23 + weekday_offset, hour, minute, tzinfo=timezone.utc)  # 2026-11-23 is a Monday
    assert gov.time_matches([{"days": [0], "start": "22:00", "end": "06:00"}], now) is expected


def test_ip_matching():
    assert gov._ip_matches([], None)
    assert gov._ip_matches(["10.0.0.0/8"], "10.1.2.3")
    assert not gov._ip_matches(["10.0.0.0/8"], "192.168.1.1")
    assert not gov._ip_matches(["10.0.0.0/8"], None)


def test_x_forwarded_for_only_from_trusted_proxy(monkeypatch):
    headers = {"x-forwarded-for": "203.0.113.7, 172.18.0.5"}
    monkeypatch.setattr(gov.settings, "TRUSTED_PROXIES", "")
    assert gov.client_ip("172.18.0.5", headers) == "172.18.0.5"      # not trusted: ignore header
    monkeypatch.setattr(gov.settings, "TRUSTED_PROXIES", "172.18.0.0/16")
    assert gov.client_ip("172.18.0.5", headers) == "203.0.113.7"     # trusted: real client
    assert gov.client_ip("198.51.100.1", headers) == "198.51.100.1"  # spoof attempt from outside


def _rule(**kw):
    base = dict(user_ids=[], group_ids=[], server_ids=[], node_ids=[], labels=[], accounts=[])
    base.update(kw)
    return SimpleNamespace(**base)


def test_subject_and_target_matching():
    uid, gid, sid, nid = (str(uuid.uuid4()) for _ in range(4))
    subject = gov.Subject(user=SimpleNamespace(id=uid), group_ids={gid})
    target = gov.Target(server_id=sid, node_ancestry={nid}, tags={"env": "prod"}, account="root")
    assert gov._subject_matches(_rule(), subject)
    assert gov._subject_matches(_rule(group_ids=[gid]), subject)
    assert not gov._subject_matches(_rule(user_ids=[str(uuid.uuid4())]), subject)
    assert gov._target_matches(_rule(), target)
    assert gov._target_matches(_rule(node_ids=[nid]), target)       # through an ancestor node
    assert gov._target_matches(_rule(labels=["env=prod"]), target)
    assert not gov._target_matches(_rule(accounts=["alice"]), target)
    assert not gov._target_matches(_rule(server_ids=[str(uuid.uuid4())]), target)
