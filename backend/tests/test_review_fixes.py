"""Fixes from the multi-agent security review (updates injection, job source IP,
terminal ACL bypasses, Azure tag overwrite)."""

import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.api import updates as updates_api
from app.schemas.update import UpdateApplyRequest
from app.services import cloud_sync, update_service
from app.services import jobs as jobs_svc
from app.services.enforcement import CommandOutcome, GovernanceDenied
from app.websocket.line_tracker import LineTracker


# ── 1. updates: package names, quoting, governance ──

@pytest.mark.parametrize("name", [
    "vim; id", "vim && id", "$(id)", "`id`", "vim|sh", "-oDpkg::Pre-Invoke=id", "a b", "x\n", "",
])
def test_update_request_rejects_shell_metacharacters(name):
    with pytest.raises(ValidationError):
        UpdateApplyRequest(packages=[name])


def test_update_request_accepts_real_package_names():
    names = ["openssl", "libc6:amd64", "g++", "python3.12", "kernel-6.1.0~rc1", "lib_x-1+deb12u1"]
    assert UpdateApplyRequest(packages=names).packages == names
    assert UpdateApplyRequest().packages is None


async def test_apply_linux_updates_quotes_package_names(monkeypatch):
    sent = {}

    async def pm(*a, **k):
        return "apt"

    async def run(host, port, user, cmd, **k):
        sent["cmd"] = cmd
        return SimpleNamespace(exit_code=0, stdout="", stderr="")

    monkeypatch.setattr(update_service, "_detect_linux_pm", pm)
    monkeypatch.setattr(update_service.ssh_service, "execute_command", run)
    await update_service.apply_linux_updates("h", 22, "u", packages=["vim; id"])
    assert "-- 'vim; id'" in sent["cmd"]


class _Db:
    def add(self, *_):
        pass

    async def commit(self):
        pass

    async def refresh(self, obj, *_):
        if getattr(obj, "id", None) is None:
            obj.id = uuid.uuid4()


def _patch_updates(monkeypatch, *, connect_error=None, outcome=None):
    server = SimpleNamespace(id=uuid.uuid4(), name="srv", os_type=updates_api.OSType.LINUX,
                             ssh_port=22, winrm_port=5985, ip_address="10.0.0.1", zone_id=None)
    grant = SimpleNamespace(allows_account=lambda _u: True)
    account = SimpleNamespace(username="root", label="root", password=b"x", ssh_key=None, use_cert=False)
    calls = {"applied": False, "logged": [], "checked": None}

    async def require_server(*a, **k):
        return server, grant

    async def enforce_connect(db, user, srv, acc, ip):
        calls["connect_ip"] = ip
        if connect_error:
            raise GovernanceDenied(connect_error)

    async def check_command(db, user, srv, acc, cmd, ip, source="execute"):
        calls["checked"] = (cmd, ip, source)
        return outcome or CommandOutcome(allowed=True)

    async def log_command(db, **k):
        calls["logged"].append(k)

    async def apply(**k):
        calls["applied"] = True
        return update_service.UpdateApplyResult(success=True, packages_updated=1, output="ok")

    monkeypatch.setattr(updates_api, "require_server", require_server)
    monkeypatch.setattr(updates_api, "default_account", lambda _s: account)
    monkeypatch.setattr(updates_api, "enforce_connect", enforce_connect)
    monkeypatch.setattr(updates_api, "check_command", check_command)
    monkeypatch.setattr(updates_api, "log_command", log_command)
    monkeypatch.setattr(updates_api.update_service, "apply_linux_updates", apply)
    return calls


def _request(ip="203.0.113.9"):
    return SimpleNamespace(state=SimpleNamespace(client_ip=ip))


USER = SimpleNamespace(id=uuid.uuid4(), display_name="op")


async def test_apply_updates_enforces_connection_acl(monkeypatch):
    calls = _patch_updates(monkeypatch, connect_error="Connexion refusée")
    with pytest.raises(HTTPException) as e:
        await updates_api.apply_updates(uuid.uuid4(), UpdateApplyRequest(), _request(), _Db(), USER)
    assert e.value.status_code == 403
    assert calls["connect_ip"] == "203.0.113.9"
    assert not calls["applied"]


async def test_apply_updates_enforces_command_acl_and_journals(monkeypatch):
    calls = _patch_updates(monkeypatch, outcome=CommandOutcome(allowed=False, message="non", decision="denied"))
    with pytest.raises(HTTPException):
        await updates_api.apply_updates(uuid.uuid4(), UpdateApplyRequest(packages=["openssl"]), _request(), _Db(), USER)
    assert calls["checked"] == ("system-update openssl", "203.0.113.9", "updates")
    assert calls["logged"][0]["decision"] == "denied"
    assert not calls["applied"]


async def test_apply_updates_allowed_is_journaled(monkeypatch):
    calls = _patch_updates(monkeypatch)
    await updates_api.apply_updates(uuid.uuid4(), UpdateApplyRequest(), _request(), _Db(), USER)
    assert calls["checked"][0] == "system-update --all"
    assert calls["applied"]
    assert calls["logged"][-1]["source"] == "updates"


# ── 2. jobs keep the launcher's IP ──

async def test_create_job_records_client_ip(monkeypatch):
    added = []

    class Db(_Db):
        def add(self, obj):
            added.append(obj)

        async def flush(self):
            for o in added:
                if getattr(o, "id", None) is None and type(o).__name__ == "Job":
                    o.id = uuid.uuid4()

    async def resolve(*a, **k):
        return [SimpleNamespace(server=SimpleNamespace(id=uuid.uuid4(), name="s"), allowed=True, reason=None)]

    async def noop(_jid):
        pass

    monkeypatch.setattr(jobs_svc, "resolve_targets", resolve)
    monkeypatch.setattr(jobs_svc, "_run_job", noop)
    job = await jobs_svc.create_job(Db(), USER, kind="command", name="x", selector={}, command="id",
                                    client_ip="198.51.100.7")
    assert job.client_ip == "198.51.100.7"


def test_job_runners_never_evaluate_acls_without_ip():
    import inspect
    src = inspect.getsource(jobs_svc)
    assert "account.username, None)" not in src
    assert "command, None, source=" not in src


# ── 3. terminal: Ctrl+O, Ctrl+X, faked alternate screen ──

def test_ctrl_o_counts_as_enter_at_the_shell_prompt():
    t = LineTracker()
    t.on_output(b"$ ")
    assert t.split(b"rm -rf /tmp/x\x0f") == [(b"rm -rf /tmp/x", True)]


def test_ctrl_x_prefix_is_dropped_at_the_shell_prompt():
    t = LineTracker()
    t.on_output(b"$ ")
    segs = t.split(b"rm -rf /\x18\x05")
    assert b"\x18" not in b"".join(c for c, _ in segs)


def test_ctrl_keys_untouched_inside_full_screen_apps():
    t = LineTracker()
    t.on_output(b"\x1b[?1049h")
    assert t.split(b"\x18") == [(b"\x18", False)]   # nano: Ctrl+X exits
    assert t.split(b"\x0f") == [(b"\x0f", False)]   # nano: Ctrl+O writes the file


def test_faked_alternate_screen_still_returns_the_typed_line():
    t = LineTracker()
    t.on_output(b"$ ")
    t.on_output(b"\x1b[?1049h$ ")  # printf '\e[?1049h'
    t.feed(b"rm -rf /")
    assert t.alt_screen
    assert t.take_line() == "rm -rf /"


# ── 4. Azure sync keeps Citadel tag values ──

def test_azure_tags_cannot_override_citadel_tags():
    merged = cloud_sync.merge_tags(
        {"env": "dev", "owner": "ops"},
        {"env": "prod", "team": "data", "cloud": "spoof"},
        {"cloud": "azure", "azure_power": "running"},
    )
    assert merged == {"env": "dev", "owner": "ops", "team": "data", "cloud": "azure", "azure_power": "running"}
