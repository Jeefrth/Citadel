"""Lot 7 / 8 helpers: masking, SSH proxy usernames, account push scripts,
backup encryption, Kubernetes namespace patterns and rights."""

from types import SimpleNamespace

import pytest

from app.services import account_backup, account_push, masking
from app.services.k8s import ns_allowed
from app.services.ssh_proxy import parse_username


# ── masking ──

def test_masking_presets_and_counts():
    m = masking.build([masking.PRESETS["password_assign"], masking.PRESETS["card"]])
    out = m.apply(b"password=hunter2 card 4111 1111 1111 1111 ok").decode()
    assert "hunter2" not in out and "4111" not in out and "ok" in out
    assert m.hits == 2


def test_masking_keeps_invalid_utf8_bytes():
    m = masking.build([masking.PRESETS["bearer"]])
    raw = b"\xff\xfe Bearer abcdefghijklmnopqrstuvwxyz \xc3"
    out = m.apply(raw)
    assert out.startswith(b"\xff\xfe") and out.endswith(b"\xc3") and b"abcdefghijkl" not in out


def test_masking_rules_validation():
    assert masking.validate_rules([{"name": "x", "pattern": "a+", "replacement": "b"}])[0]["enabled"] is True
    with pytest.raises(ValueError):
        masking.validate_rules([{"name": "x", "pattern": "("}])
    with pytest.raises(ValueError):
        masking.validate_rules([{"name": "", "pattern": "a"}])


# ── SSH proxy ──

@pytest.mark.parametrize("raw,parsed", [
    ("jf@x.ch", ("jf@x.ch", None, None)),
    ("jf@x.ch#web-01", ("jf@x.ch", None, "web-01")),
    ("jf@x.ch#root#web-01", ("jf@x.ch", "root", "web-01")),
    ("jf#root#a#b", ("jf", "root", "a#b")),
])
def test_proxy_username(raw, parsed):
    assert parse_username(raw) == parsed


# ── account push ──

def _tpl(**kw):
    base = dict(name="t", username="citops", os_scope="linux", secret_type="password", sudo="none", groups=[],
                password_length=24)
    base.update(kw)
    return SimpleNamespace(**base)


def test_template_validation():
    account_push.validate_template("citops", "any", "password", "none", ["docker"])
    for args in [("root", "any", "password", "none", []), ("Bad Name", "linux", "password", "none", []),
                 ("svc", "windows", "ssh_key", "none", []), ("svc", "windows", "password", "nopasswd", []),
                 ("svc", "linux", "password", "none", ["bad;group"])]:
        with pytest.raises(ValueError):
            account_push.validate_template(*args)


def test_linux_script_sudo_and_key():
    s = account_push.linux_script(_tpl(secret_type="ssh_key", sudo="nopasswd", groups=["docker"]),
                                  account_push._Secret(public_key="ssh-ed25519 AAAAC3Nza citadel-citops"))
    assert "useradd -m -s /bin/bash citops" in s and "usermod -aG docker citops" in s
    assert "visudo -cf" in s and "NOPASSWD: ALL" in s and "usermod -p '*' citops" in s
    assert "authorized_keys" in s and s.rstrip().endswith("echo citadel-push-ok")
    s2 = account_push.linux_script(_tpl(), account_push._Secret(password="x"))
    assert "rm -f /etc/sudoers.d/citadel-citops" in s2 and "usermod -p" not in s2


def test_windows_script_groups():
    s = account_push.windows_script(_tpl(os_scope="windows", groups=["Administrators"]), account_push._Secret(password="Pw-1"))
    assert "New-LocalUser -Name 'citops'" in s and "Add-LocalGroupMember -Group $g" in s and "'Administrators'" in s


# ── backup ──

def test_backup_roundtrip_and_tamper():
    blob = account_backup.encrypt_archive({"accounts": [{"username": "a", "password": "p"}]}, "x" * 20)
    assert blob.startswith(account_backup.MAGIC.encode())
    assert account_backup.decrypt_archive(blob, "x" * 20)["accounts"][0]["password"] == "p"
    with pytest.raises(ValueError):
        account_backup.decrypt_archive(blob, "y" * 20)
    tampered = blob.replace(b'"ciphertext": "', b'"ciphertext": "AA')
    with pytest.raises(ValueError):
        account_backup.decrypt_archive(tampered, "x" * 20)


# ── Kubernetes ──

@pytest.mark.parametrize("patterns,ns,ok", [
    ({"*"}, "anything", True), ({"demo"}, "demo", True), ({"demo"}, "demo2", False),
    ({"team-*"}, "team-a", True), ({"team-*"}, "prod", False), (set(), "demo", False),
])
def test_ns_patterns(patterns, ns, ok):
    assert ns_allowed(patterns, ns) is ok


def test_cluster_grant_can():
    from app.services.k8s_access import ClusterGrant
    g = ClusterGrant(actions={"view", "logs"}, namespaces={"dem*"})
    assert g.can("view", "demo") and not g.can("exec", "demo") and not g.can("view", "prod")
