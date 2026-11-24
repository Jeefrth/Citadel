"""Unit tests for access policy evaluation and account resolution (no DB)."""

import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.core.permissions import (
    ADMIN_GRANT, ServerGrant, _label_matches, _role_ceiling, connectable_accounts,
    node_descendants, resolve_for_user, user_login_name,
)
from app.models.base import CredentialType, UserRole


def _cred(**kw):
    base = dict(type=CredentialType.SSH_PASSWORD, encrypted_password=b"pw", encrypted_ssh_key=None,
                cert_validity_minutes=None)
    base.update(kw)
    return SimpleNamespace(**base)


def _acc(username, cred=None, use_cert=False, is_default=False, active=True):
    return SimpleNamespace(id=uuid.uuid4(), username=username, credential=cred, use_cert=use_cert,
                           is_default=is_default, is_active=active, privileged=False)


def _server(*accounts):
    return SimpleNamespace(accounts=list(accounts))


USER = SimpleNamespace(email="Jean.Dupont@example.test", role=UserRole.OPERATOR)


def test_node_descendants_includes_subtree_only():
    a, b, c, d = (uuid.uuid4() for _ in range(4))
    nodes = [(a, None), (b, a), (c, b), (d, None)]
    assert node_descendants(nodes, {a}) == {a, b, c}
    assert node_descendants(nodes, {d}) == {d}


def test_node_descendants_survives_cycles():
    a, b = uuid.uuid4(), uuid.uuid4()
    assert node_descendants([(a, b), (b, a)], {a}) == {a, b}


@pytest.mark.parametrize("tags,selectors,expected", [
    ({"env": "prod"}, ["env=prod"], True),
    ({"env": "dev"}, ["env=prod"], False),
    ({"env": "dev"}, ["env="], True),          # key-only selector
    ({"env": "dev"}, ["env=prod", "env=dev"], True),  # any match
    (None, ["env=prod"], False),
    ({"env": "prod"}, [], False),
])
def test_label_matches(tags, selectors, expected):
    assert _label_matches(tags, selectors) is expected


def test_viewer_never_gets_execute():
    viewer = SimpleNamespace(role=UserRole.VIEWER)
    assert _role_ceiling(viewer, {"connect", "execute"}) == {"connect"}
    operator = SimpleNamespace(role=UserRole.OPERATOR)
    assert _role_ceiling(operator, {"connect", "execute"}) == {"connect", "execute"}


def test_resolve_default_picks_granted_default():
    root = _acc("root", _cred(), is_default=True)
    jf = _acc("jf", use_cert=True)
    grant = ServerGrant(actions={"connect"}, accounts={"jf"})
    acc = resolve_for_user(_server(root, jf), grant, USER)
    assert acc.username == "jf" and acc.use_cert


def test_resolve_refuses_ungranted_account():
    root = _acc("root", _cred(), is_default=True)
    grant = ServerGrant(actions={"connect"}, accounts={"jf"})
    with pytest.raises(HTTPException) as e:
        resolve_for_user(_server(root), grant, USER, account_id=str(root.id))
    assert e.value.status_code == 403


def test_resolve_all_alias_grants_every_real_account():
    root = _acc("root", _cred(), is_default=True)
    grant = ServerGrant(actions={"connect"}, accounts={"@ALL"})
    assert resolve_for_user(_server(root), grant, USER).username == "root"


def test_resolve_user_alias_uses_cert_and_upn_local_part():
    grant = ServerGrant(actions={"connect"}, accounts={"@USER"})
    acc = resolve_for_user(_server(), grant, USER, virtual="@USER")
    assert acc.username == "jean.dupont" and acc.use_cert
    assert user_login_name(USER) == "jean.dupont"


def test_resolve_input_alias_requires_grant_and_credentials(monkeypatch):
    monkeypatch.setattr("app.core.permissions.encrypt_value", lambda v: b"enc:" + v.encode())
    grant = ServerGrant(actions={"connect"}, accounts={"@INPUT"})
    acc = resolve_for_user(_server(), grant, USER, virtual="@INPUT", input_username="bob", input_password="s3cr3t")
    assert acc.username == "bob" and acc.password == b"enc:s3cr3t" and not acc.use_cert
    with pytest.raises(HTTPException):
        resolve_for_user(_server(), grant, USER, virtual="@INPUT", input_username="bob")
    with pytest.raises(HTTPException):
        resolve_for_user(_server(), ServerGrant(accounts={"@ALL"}), USER, virtual="@INPUT",
                         input_username="bob", input_password="x")


def test_inactive_accounts_are_ignored():
    old = _acc("old", _cred(), is_default=True, active=False)
    grant = ServerGrant(actions={"connect"}, accounts={"@ALL"})
    with pytest.raises(HTTPException) as e:
        resolve_for_user(_server(old), grant, USER)
    assert e.value.status_code == 403


def test_connectable_accounts_lists_real_and_virtual():
    root = _acc("root", _cred(), is_default=True)
    jf = _acc("jf", use_cert=True)
    grant = ServerGrant(accounts={"jf", "@INPUT"})
    names = [a["username"] for a in connectable_accounts(_server(root, jf), grant)]
    assert names == ["jf", "@INPUT"]
    assert {a["username"] for a in connectable_accounts(_server(root, jf), ADMIN_GRANT)} == {"root", "jf", "@USER", "@INPUT"}
