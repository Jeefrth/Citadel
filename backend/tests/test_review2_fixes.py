"""Fixes from the second security review (lots 6-8)."""

import inspect
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.base import UserRole
from app.services import ssh_proxy
from app.services.k8s_access import ClusterGrant


def test_k8s_rules_are_not_mixed_between_policies():
    g = ClusterGrant(rules=[(frozenset({"view", "exec", "manage"}), frozenset({"dev"})),
                            (frozenset({"view"}), frozenset({"*"}))])
    assert g.can("exec", "dev") and g.can("manage", "dev")
    assert g.can("view", "prod")
    assert not g.can("exec", "prod") and not g.can("manage", "prod") and not g.can("logs", "prod")


def test_k8s_glob_rule_alone():
    g = ClusterGrant(rules=[(frozenset({"view", "logs"}), frozenset({"team-*"}))])
    assert g.can("logs", "team-a") and not g.can("logs", "prod") and not g.sees_namespace("prod")


async def test_public_key_probe_does_not_sign_in(monkeypatch):
    """asyncssh asks about a key before any signature: nothing may be decided or logged then."""
    srv = ssh_proxy._ProxyServer()
    recorded = []

    class _Db:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def execute(self, *_):
            return SimpleNamespace(scalar_one_or_none=lambda: SimpleNamespace(id="k1", name="laptop"))

    async def find_user(db, login):
        return SimpleNamespace(id="u1", display_name="Victim")

    async def allowed(*a):
        return True

    async def record(*a, **k):
        recorded.append(a)

    monkeypatch.setattr(ssh_proxy, "async_session", lambda: _Db())
    monkeypatch.setattr(ssh_proxy, "find_user", find_user)
    monkeypatch.setattr(ssh_proxy, "_login_allowed", allowed)
    monkeypatch.setattr(ssh_proxy, "_record", record)
    key = SimpleNamespace(get_fingerprint=lambda _h: "SHA256:x")
    assert await srv.validate_public_key("victim@x.ch", key) is True
    assert srv.user_id is None and recorded == []          # probe only: no session owner, no log
    src = inspect.getsource(ssh_proxy._ProxyServer.validate_public_key)
    assert "last_used_at" not in src and "_record(" not in src


def test_privileged_templates_are_admin_only():
    from app.api.operations import _privileged_tpl_guard
    op = SimpleNamespace(role=UserRole.OPERATOR)
    admin = SimpleNamespace(role=UserRole.ADMIN)
    plain = SimpleNamespace(privileged=False, sudo="none", groups=[])
    for risky in (SimpleNamespace(privileged=True, sudo="none", groups=[]),
                  SimpleNamespace(privileged=False, sudo="nopasswd", groups=[]),
                  SimpleNamespace(privileged=False, sudo="none", groups=["docker"])):
        with pytest.raises(HTTPException):
            _privileged_tpl_guard(op, risky)
        _privileged_tpl_guard(admin, risky)
        with pytest.raises(HTTPException):
            _privileged_tpl_guard(op, plain, risky)   # editing a plain template into a risky one
    _privileged_tpl_guard(op, plain)
