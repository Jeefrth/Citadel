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
