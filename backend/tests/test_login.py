"""Sign-in helpers (SaaS phase 3)."""
from types import SimpleNamespace

import pytest


def prov(kind="oidc", domains=None, issuer="https://idp.example"):
    return SimpleNamespace(kind=kind, domains=domains or [], issuer=issuer, client_id="c")


def test_entra_identity_uses_oid_and_refuses_guests():
    from app.services.oidc import identity_from_claims
    i = identity_from_claims(prov("entra"), {"iss": "https://login.microsoftonline.com/t/v2.0", "sub": "pairwise",
                                             "oid": "OID", "preferred_username": "Jean@Corp.com", "name": "J"})
    assert i.subject == "OID" and i.email == "jean@corp.com" and i.email_verified
    g = identity_from_claims(prov("entra"), {"iss": "x", "sub": "s", "oid": "o", "preferred_username": "a_b.com#EXT#@t.onmicrosoft.com"})
    assert not g.email_verified and g.email == ""


def test_generic_identity_needs_email_verified():
    from app.services.oidc import identity_from_claims
    i = identity_from_claims(prov(), {"iss": "https://idp.example", "sub": "1", "email": "A@B.c"})
    assert i.email == "a@b.c" and not i.email_verified
    i = identity_from_claims(prov(), {"iss": "https://idp.example", "sub": "1", "email": "a@b.c", "email_verified": True})
    assert i.email_verified


@pytest.mark.parametrize("path,expected", [("/servers", "/servers"), ("//evil.com", "/"), ("https://evil.com", "/"),
                                           ("/\\evil.com", "/"), ("/a\r\nSet-Cookie: x", "/"), (None, "/")])
def test_return_to_stays_in_app(path, expected):
    from app.api.login import _safe_return
    assert _safe_return(path) == expected


def test_domain_restriction():
    from app.services.login import domain_allowed
    from app.services.oidc import ExternalIdentity
    p = prov(domains=["acme.test"])
    assert domain_allowed(p, ExternalIdentity("i", "s", "x@acme.test", True, "x"))
    assert not domain_allowed(p, ExternalIdentity("i", "s", "x@acme.test", False, "x"))   # unverified
    assert not domain_allowed(p, ExternalIdentity("i", "s", "x@evil.test", True, "x"))
    assert domain_allowed(prov(), ExternalIdentity("i", "s", "", False, "x"))             # no domains listed


def test_entra_multitenant_issuer_detection():
    from app.services.oidc import _is_entra_multi
    assert _is_entra_multi("https://login.microsoftonline.com/organizations/v2.0")
    assert not _is_entra_multi("https://login.microsoftonline.com/38d9b3f4-0000-0000-0000-000000000000/v2.0")


@pytest.mark.parametrize("issuer", [
    "https://evil.example/login.microsoftonline.com/organizations",
    "https://evil.example/login.microsoftonline.com/organizations/v2.0",
    "https://login.microsoftonline.com.evil.example/organizations/v2.0",
    "http://login.microsoftonline.com/organizations/v2.0",
])
def test_entra_multitenant_lookalikes_rejected(issuer):
    from app.services.oidc import _is_entra_multi
    assert not _is_entra_multi(issuer)


def test_endpoints_must_stay_on_the_issuer_host():
    from app.services.oidc import _endpoint_ok
    assert _endpoint_ok("https://acme.okta.com", "https://acme.okta.com/oauth2/v1/keys")
    assert not _endpoint_ok("https://acme.okta.com", "https://evil.example/keys")
    assert _endpoint_ok("https://accounts.google.com", "https://www.googleapis.com/oauth2/v3/certs")
    assert not _endpoint_ok("https://evil.example", "https://www.googleapis.com/oauth2/v3/certs")


@pytest.mark.asyncio
@pytest.mark.parametrize("url", ["https://127.0.0.1/x", "https://169.254.169.254/latest", "https://10.0.0.5/",
                                 "https://localhost/", "http://example.com/"])
async def test_provider_urls_cannot_reach_internal_networks(url, monkeypatch):
    from app.services import oidc
    monkeypatch.setattr(oidc.settings, "OIDC_ALLOW_HTTP", False)
    with pytest.raises(oidc.OIDCError):
        await oidc._check_public(url)


def test_email_trust_depends_on_provider():
    from types import SimpleNamespace
    from app.services.login import trusted_email
    from app.services.oidc import ExternalIdentity
    ident = ExternalIdentity("i", "s", "cfo@victim.test", True, "x")
    platform = SimpleNamespace(org_id=None, verified_domains=[])
    org_unverified = SimpleNamespace(org_id="o", verified_domains=[])
    org_verified = SimpleNamespace(org_id="o", verified_domains=["victim.test"])
    assert trusted_email(platform, ident) == "cfo@victim.test"
    assert trusted_email(org_unverified, ident) == ""
    assert trusted_email(org_verified, ident) == "cfo@victim.test"
    assert trusted_email(platform, ExternalIdentity("i", "s", "a@b.c", False, "x")) == ""


def test_popup_page_has_no_injectable_script():
    from app.api.login import _popup_result
    body = _popup_result("reauth", False, '</script><script>alert(1)</script>').body.decode()
    assert "<script>alert(1)" not in body and "alert(1)</script>" not in body.split('id="citadel-result">')[1].split("</script>")[0] + "x"
    assert body.count("<script") == 2 and 'src="/api/auth/popup.js"' in body
