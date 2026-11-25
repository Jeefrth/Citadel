"""Organisation isolation primitives (SaaS phase 1): context, per-organisation keys."""
import uuid

import pytest

from tests.test_secrets import TEST_KEY

ORG_A = uuid.uuid4()
ORG_B = uuid.uuid4()
KEY_A = "citadel-org-" + ORG_A.hex
KEY_B = "citadel-org-" + ORG_B.hex


@pytest.fixture
def sec(monkeypatch):
    from app.core import security
    monkeypatch.setattr(security.settings, "CREDENTIAL_ENCRYPTION_KEY", TEST_KEY)
    monkeypatch.setattr(security.settings, "SECRETS_BACKEND", "local")
    return security


def test_default_context_writes_plain_blobs(sec):
    blob = sec.encrypt_value("x")
    assert sec.split_blob(blob)[0] is None
    assert sec.decrypt_value(blob) == "x"


def test_org_blob_is_prefixed_and_only_readable_in_its_org(sec):
    from app.core import tenancy
    with tenancy.tenant(ORG_A, KEY_A):
        blob = sec.encrypt_value("secret-a")
        assert sec.split_blob(blob)[0] == KEY_A
        assert sec.decrypt_value(blob) == "secret-a"
    with tenancy.tenant(ORG_B, KEY_B):
        with pytest.raises(sec.KeyMismatch):
            sec.decrypt_value(blob)
    with tenancy.tenant(ORG_B, None):          # default organisation
        with pytest.raises(sec.KeyMismatch):
            sec.decrypt_value(blob)
    with tenancy.system():                     # platform code reads everything
        assert sec.decrypt_value(blob) == "secret-a"


def test_default_blob_refused_in_another_org(sec):
    from app.core import tenancy
    blob = sec.encrypt_value("default")
    with tenancy.tenant(ORG_A, KEY_A):
        with pytest.raises(sec.KeyMismatch):
            sec.decrypt_value(blob)


def test_forged_prefix_cannot_change_the_key(sec):
    """Stripping or swapping the prefix does not give access: derived keys differ."""
    from app.core import tenancy
    with tenancy.tenant(ORG_A, KEY_A):
        blob = sec.encrypt_value("secret-a")
    _, inner = sec.split_blob(blob)
    forged = sec.join_blob(KEY_B, inner)
    with tenancy.tenant(ORG_B, KEY_B):
        with pytest.raises(Exception):
            sec.decrypt_value(forged)
    with pytest.raises(Exception):
        sec.decrypt_value(inner)               # as a default-key blob


@pytest.mark.parametrize("bad", [b"okey:|x", b"okey:../../sys/policy|vault:v1:x", b"okey:citadel-org-zz|x", b"okey:noseparator"])
def test_malformed_org_blob_rejected(sec, bad):
    with pytest.raises(ValueError):
        sec.split_blob(bad)


def test_context_is_scoped_and_restored():
    from app.core import tenancy
    assert tenancy.current() is None
    with tenancy.tenant(ORG_A, KEY_A):
        assert tenancy.require_org_id() == ORG_A
        with tenancy.system():
            assert tenancy.current().bypass
        assert tenancy.current_org_id() == ORG_A
    assert tenancy.current() is None
    with pytest.raises(tenancy.TenantError):
        tenancy.require_org_id()


def test_org_ca_requires_own_ca_for_org_with_own_key():
    from app.core import tenancy
    from app.services import ca_service
    with tenancy.tenant(ORG_A, KEY_A):         # own key, no CA: refuse to sign with the platform CA
        with pytest.raises(RuntimeError):
            ca_service._org_ca()
    with tenancy.tenant(ORG_B, None):          # default organisation: platform CA
        assert ca_service._org_ca() is None


def test_ssh_proxy_org_prefix():
    from app.services.ssh_proxy import split_org
    assert split_org("acme:web01") == ("acme", "web01")
    assert split_org("web01") == (None, "web01")
    assert split_org("ACME:k8s/c/ns/pod") == ("acme", "k8s/c/ns/pod")
    assert split_org(None) == (None, None)


@pytest.mark.parametrize("slug", ["12345678-1234-1234-1234-123456789abc", "12345678123412341234123456789abc", "default", "a", "Acme"])
def test_slug_rejected(slug):
    from fastapi import HTTPException
    from app.services.orgs import check_slug
    with pytest.raises(HTTPException):
        check_slug(slug)


def test_slug_accepted():
    from app.services.orgs import check_slug
    assert check_slug(" acme-corp ") == "acme-corp"
