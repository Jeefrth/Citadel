"""E2E sign-in through OIDC providers (SaaS phase 3), against a mock provider.

Run in the backend container on a migrated database, with the branch code on
PYTHONPATH and a test server on port 8001 started with OIDC_ALLOW_HTTP=true and
PUBLIC_URL=http://localhost:8001 (see docs/saas-phase3.md).
"""
import asyncio
import json
import secrets
import sys
import time
import uuid
from urllib.parse import parse_qs, urlencode, urlparse

sys.path.insert(0, "/tmp/saas")
import httpx
import uvicorn
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI, Form, Request
from fastapi.responses import JSONResponse, RedirectResponse
from jose import jwk, jwt
from sqlalchemy import delete, select, text, update

from app.core import tenancy
from app.core.database import async_session
from app.models.auth import AuthSession, IdentityProvider, UserIdentity
from app.models.base import UserRole
from app.models.organization import OrgInvitation, OrgMembership, Organization
from app.models.user import User

API = "http://localhost:8001"
IDP = "http://localhost:8099"
fails = []


def check(c, label):
    print(("OK   " if c else "FAIL ") + label)
    c or fails.append(label)


# ── mock OIDC provider ──
_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
from cryptography.hazmat.primitives import serialization  # noqa: E402
PEM = _key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
PUB = jwk.construct(_key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode(),
                    "RS256").to_dict()
PUB.update(kid="k1", use="sig", alg="RS256")
for k in ("d", "p", "q", "dp", "dq", "qi"):
    PUB.pop(k, None)
PEOPLE = {
    "alice": {"sub": "alice-1", "email": "alice@acme.test", "email_verified": True, "name": "Alice Acme"},
    "bob": {"sub": "bob-1", "email": "bob@evil.test", "email_verified": True, "name": "Bob Evil"},
    "carol": {"sub": "carol-1", "email": "carol@ext.test", "email_verified": True, "name": "Carol Ext"},
    "dave": {"sub": "dave-1", "email": "dave@ext.test", "email_verified": False, "name": "Dave Unverified"},
    "eve": {"sub": "eve-1", "email": "eve@nowhere.test", "email_verified": True, "name": "Eve Nobody"},
}
codes: dict[str, dict] = {}
idp = FastAPI()


@idp.get("/.well-known/openid-configuration")
def disco():
    return {"issuer": IDP, "authorization_endpoint": f"{IDP}/authorize", "token_endpoint": f"{IDP}/token",
            "jwks_uri": f"{IDP}/jwks", "token_endpoint_auth_methods_supported": ["client_secret_basic"]}


@idp.get("/jwks")
def jwks():
    return {"keys": [PUB]}


@idp.get("/authorize")
def authorize(request: Request):
    q = request.query_params
    who = q.get("login_hint") or "alice"
    code = secrets.token_urlsafe(16)
    codes[code] = {"who": who, "nonce": q["nonce"], "client_id": q["client_id"], "challenge": q["code_challenge"],
                   "prompt": q.get("prompt")}
    return RedirectResponse(f"{q['redirect_uri']}?{urlencode({'code': code, 'state': q['state']})}", status_code=302)


@idp.post("/token")
def token(code: str = Form(...), code_verifier: str = Form(...)):
    import base64
    import hashlib
    c = codes.pop(code, None)
    if c is None:
        return JSONResponse({"error": "invalid_grant"}, status_code=400)
    ch = base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode()).digest()).rstrip(b"=").decode()
    if ch != c["challenge"]:
        return JSONResponse({"error": "invalid_grant", "error_description": "pkce"}, status_code=400)
    now = int(time.time())
    claims = {**PEOPLE[c["who"]], "iss": IDP, "aud": c["client_id"], "nonce": c["nonce"], "iat": now, "exp": now + 300,
              "auth_time": now}
    return {"id_token": jwt.encode(claims, PEM, algorithm="RS256", headers={"kid": "k1"}), "token_type": "Bearer"}


async def sign_in(provider_id, who: str, return_to: str = "/") -> httpx.Response:
    """Browser walk: Citadel login -> provider -> Citadel callback. Returns the callback response."""
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.get(f"{API}/api/auth/login/{provider_id}", params={"return_to": return_to, "login_hint": who})
        assert r.status_code == 302, r.text
        r = await c.get(r.headers["location"])        # provider -> 302 back
        cb = r.headers["location"]
        r = await c.get(cb)
        r.callback_url = cb
        return r


async def refresh(cookie: str | None):
    async with httpx.AsyncClient(timeout=20) as c:
        return await c.post(f"{API}/api/auth/refresh", headers={"X-Citadel-Refresh": "1"},
                            cookies={"citadel_refresh": cookie} if cookie else None)


def cookie_of(r) -> str | None:
    for h in r.headers.get_list("set-cookie"):
        if h.startswith("citadel_refresh="):
            return h.split(";", 1)[0].split("=", 1)[1]
    return None


async def main():
    server = uvicorn.Server(uvicorn.Config(idp, host="127.0.0.1", port=8099, log_level="warning"))
    task = asyncio.create_task(server.serve())
    await asyncio.sleep(1)
    emails = [p["email"] for p in PEOPLE.values()]
    async with async_session() as db:
        with tenancy.system():
            await db.execute(delete(Organization).where(Organization.slug == "acme-sso"))
            await db.execute(delete(IdentityProvider).where(IdentityProvider.issuer == IDP))
            await db.execute(text("delete from audit_logs where user_id in (select id from users where email = any(:e))"), {"e": emails})
            await db.execute(delete(User).where(User.email.in_(emails)))
            await db.commit()
            jf = (await db.execute(select(User).where(User.is_platform_admin))).scalars().first()
            default = (await db.execute(select(Organization).where(Organization.is_default))).scalar_one()
    from app.services.orgs import create_org
    async with async_session() as db:
        acme = await create_org(db, "Acme SSO", "acme-sso", None, jf)
        acme_id = acme.id
    async with async_session() as db:
        with tenancy.system():
            plat = IdentityProvider(org_id=None, kind="oidc", name="Mock plateforme", issuer=IDP, client_id="citadel-platform")
            org_p = IdentityProvider(org_id=acme_id, kind="okta", name="Okta Acme", issuer=IDP, client_id="citadel-acme",
                                     domains=["acme.test", "pending.test"], verified_domains=["acme.test"], jit_role=UserRole.VIEWER)
            db.add_all([plat, org_p])
            db.add(OrgInvitation(org_id=default.id, email="carol@ext.test", role=UserRole.OPERATOR))
            db.add(OrgInvitation(org_id=default.id, email="dave@ext.test", role=UserRole.OPERATOR))
            await db.commit()
            plat_id, org_pid = plat.id, org_p.id
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            provs = (await c.get(f"{API}/api/auth/providers")).json()
            check(any(p["id"] == str(plat_id) for p in provs) and all(p["id"] != str(org_pid) for p in provs),
                  "sign-in page lists platform providers only")
            d = (await c.post(f"{API}/api/auth/discover", json={"value": "someone@ACME.test"})).json()
            check([p["id"] for p in d] == [str(org_pid)], "discovery by e-mail domain finds the organisation SSO")
            d = (await c.post(f"{API}/api/auth/discover", json={"value": "acme-sso"})).json()
            check([p["id"] for p in d] == [str(org_pid)], "discovery by organisation identifier")
            check((await c.post(f"{API}/api/auth/discover", json={"value": "x@unknown.test"})).json() == [], "no hint for unknown domains")
            check((await c.post(f"{API}/api/auth/discover", json={"value": "x@pending.test"})).json() == [],
                  "a domain not approved by the platform is not used for discovery")

        # Unknown person, no invitation, platform provider: refused, nothing created
        r = await sign_in(plat_id, "eve")
        check(r.status_code == 302 and "auth_error" in r.headers["location"] and cookie_of(r) is None, "no invitation: refused")
        async with async_session() as db:
            n = (await db.execute(select(User).where(User.email == "eve@nowhere.test"))).first()
        check(n is None, "no account created when refused")

        # Organisation SSO with JIT: account + membership
        r = await sign_in(org_pid, "alice", "/servers")
        ck = cookie_of(r)
        check(r.status_code == 302 and r.headers["location"] == "/servers" and ck, "JIT sign-in through the organisation SSO")
        rr = await refresh(ck)
        check(rr.status_code == 200 and rr.json().get("access_token"), "refresh gives an access token")
        tok, ck2 = rr.json()["access_token"], cookie_of(rr)
        check(ck2 and ck2 != ck, "refresh cookie rotated")
        async with httpx.AsyncClient(timeout=20) as c:
            me = (await c.get(f"{API}/api/auth/me", headers={"Authorization": f"Bearer {tok}"})).json()
        check(me.get("org", {}).get("slug") == "acme-sso" and me["role"] == "viewer", f"member of acme as viewer ({me.get('org')})")
        bad = await refresh(None)
        check(bad.status_code == 401, "refresh without cookie refused")
        async with httpx.AsyncClient(timeout=20) as c:
            nohdr = await c.post(f"{API}/api/auth/refresh", cookies={"citadel_refresh": ck2})
        check(nohdr.status_code == 403, "refresh without the anti-CSRF header refused")

        # replayed callback
        async with httpx.AsyncClient(timeout=20) as c:
            again = await c.get(r.callback_url)
        check("auth_error" in again.headers.get("location", ""), "a callback cannot be replayed")
        # login CSRF: a callback URL started in the attacker's browser, opened in the victim's
        async with httpx.AsyncClient(timeout=20) as attacker, httpx.AsyncClient(timeout=20) as victim:
            r0 = await attacker.get(f"{API}/api/auth/login/{org_pid}", params={"login_hint": "alice"})
            r0 = await attacker.get(r0.headers["location"])
            rv = await victim.get(r0.headers["location"])
        check("auth_error" in rv.headers.get("location", "") and cookie_of(rv) is None,
              "callback opened in another browser refused (login CSRF)")

        # Domain restriction of the organisation SSO
        r = await sign_in(org_pid, "bob")
        check("auth_error" in r.headers.get("location", "") and cookie_of(r) is None, "organisation SSO refuses other domains")

        # Invitation + verified e-mail through the platform provider
        r = await sign_in(plat_id, "carol")
        ckc = cookie_of(r)
        check(ckc is not None, "invited person (verified e-mail) gets an account")
        tokc = (await refresh(ckc)).json()["access_token"]
        async with httpx.AsyncClient(timeout=20) as c:
            me = await c.get(f"{API}/api/auth/me", headers={"Authorization": f"Bearer {tokc}"})
            check(me.status_code == 403 and "Aucune organisation" in me.text, "no membership before accepting the invitation")
            inv = (await c.get(f"{API}/api/me/invitations", headers={"Authorization": f"Bearer {tokc}"})).json()
            check(len(inv) == 1 and inv[0]["role"] == "operator", "invitation visible without any organisation")
            acc = await c.post(f"{API}/api/me/invitations/{inv[0]['id']}/accept", headers={"Authorization": f"Bearer {tokc}"})
            check(acc.status_code == 200, "invitation accepted")
            me = (await c.get(f"{API}/api/auth/me", headers={"Authorization": f"Bearer {tokc}"})).json()
            check(me.get("org", {}).get("is_default") and me["role"] == "operator", "operator of the default organisation")
            ids = (await c.get(f"{API}/api/auth/identities", headers={"Authorization": f"Bearer {tokc}"})).json()
            check(len(ids) == 1 and ids[0]["provider"]["name"] == "Mock plateforme", "identity listed in Mon compte")
            un = await c.delete(f"{API}/api/auth/identities/{ids[0]['id']}", headers={"Authorization": f"Bearer {tokc}"})
            check(un.status_code == 400, "cannot remove the only sign-in method")

        # An organisation SSO cannot claim invitations for addresses outside its approved domains
        async with async_session() as db:
            with tenancy.system():
                db.add(OrgInvitation(org_id=default.id, email="eve@nowhere.test", role=UserRole.ADMIN))
                await db.execute(update(IdentityProvider).where(IdentityProvider.id == org_pid).values(jit_role=None))
                await db.commit()
        r = await sign_in(org_pid, "eve")
        check("auth_error" in r.headers.get("location", "") and cookie_of(r) is None,
              "org SSO asserting a verified address outside its approved domains cannot claim an invitation")
        async with async_session() as db:
            with tenancy.system():
                await db.execute(update(IdentityProvider).where(IdentityProvider.id == org_pid).values(jit_role=UserRole.VIEWER))
                await db.commit()

        # Invitation but unverified e-mail: refused
        r = await sign_in(plat_id, "dave")
        check("auth_error" in r.headers.get("location", ""), "invitation with an unverified e-mail: refused")

        # Enforced organisation SSO: a platform-provider session cannot enter acme
        async with async_session() as db:
            with tenancy.system():
                carol = (await db.execute(select(User).where(User.email == "carol@ext.test"))).scalar_one()
                db.add(OrgMembership(org_id=acme_id, user_id=carol.id, role=UserRole.VIEWER))
                await db.execute(update(IdentityProvider).where(IdentityProvider.id == org_pid).values(enforced=True))
                await db.commit()
        async with httpx.AsyncClient(timeout=20) as c:
            r1 = await c.get(f"{API}/api/servers/", headers={"Authorization": f"Bearer {tokc}", "X-Citadel-Org": "acme-sso"})
            r2 = await c.get(f"{API}/api/servers/", headers={"Authorization": f"Bearer {tok}", "X-Citadel-Org": "acme-sso"})
        check(r1.status_code == 403 and "exige" in r1.text, "enforced SSO: other session refused in acme")
        check(r2.status_code == 200, "enforced SSO: session from it accepted")

        # Re-authentication: popup flow moves auth_time forward
        async with async_session() as db:
            with tenancy.system():
                await db.execute(text("update auth_sessions set auth_time = now() - interval '1 hour'"))
                await db.commit()
        rr = await refresh(ck2)
        tok, ck3 = rr.json()["access_token"], cookie_of(rr)
        old_auth = rr.json()["auth_time"]
        import websockets
        try:
            async with websockets.connect(f"ws://localhost:8001/ws/terminal/{uuid.uuid4()}") as ws:
                await ws.send(json.dumps({"type": "auth", "token": tok, "org": "acme-sso"}))
                msg = await asyncio.wait_for(ws.recv(), 5)
            check("reauth_required" in msg, "terminal refused without a recent sign-in")
        except Exception as e:  # noqa: BLE001
            check(False, f"terminal reauth check ({e})")
        async with httpx.AsyncClient(timeout=20) as c:
            u = (await c.post(f"{API}/api/auth/reauth", headers={"Authorization": f"Bearer {tok}"})).json()["url"]
            qs = parse_qs(urlparse(u).query)
            check(qs.get("prompt") == ["login"] and qs.get("max_age") == ["0"], "re-authentication forces a new sign-in")
            r = await c.get(u + "&" + urlencode({"login_hint": "alice"}))
            r = await c.get(r.headers["location"])   # no session cookie: another browser
            check('"ok": false' in r.text, "re-authentication popup refused outside the session's browser")
        async with httpx.AsyncClient(timeout=20, cookies={"citadel_refresh": ck3}) as c:
            u = (await c.post(f"{API}/api/auth/reauth", headers={"Authorization": f"Bearer {tok}"})).json()["url"]
            r = await c.get(u + "&" + urlencode({"login_hint": "alice"}))
            r = await c.get(r.headers["location"])
            check(r.status_code == 200 and '"ok": true' in r.text and "<script>" not in r.text.split("application/json")[0],
                  "re-authentication popup reports success (no inline script)")
            x = await c.get(f"{API}/api/auth/callback", params={"state": "x", "error": "</script><script>alert(1)</script>"})
            check("alert(1)" not in x.text and "alert(1)" not in x.headers.get("location", ""), "provider error never reflected")
        rr = await refresh(ck3)
        check(rr.json()["auth_time"] > old_auth, "session auth_time moved forward")
        tok = rr.json()["access_token"]
        try:
            async with websockets.connect(f"ws://localhost:8001/ws/terminal/{uuid.uuid4()}") as ws:
                await ws.send(json.dumps({"type": "auth", "token": tok, "org": "acme-sso"}))
                msg = await asyncio.wait_for(ws.recv(), 5)
            check("reauth_required" not in msg, f"terminal accepted after re-authentication ({msg[:80]})")
        except Exception as e:  # noqa: BLE001
            check(False, f"terminal after reauth ({e})")

        # Stolen cookie: reuse of a rotated cookie (after the grace period) revokes the session
        async with async_session() as db:
            with tenancy.system():
                await db.execute(text("update auth_sessions set last_used_at = now() - interval '1 minute'"))
                await db.commit()
        reuse = await refresh(ck)   # the very first cookie, rotated long ago
        check(reuse.status_code == 401, "old cookie refused")
        latest = await refresh(cookie_of(rr))
        check(latest.status_code == 401, "...and the whole session is revoked after a reuse")
        async with httpx.AsyncClient(timeout=20) as c:
            gone = await c.get(f"{API}/api/auth/me", headers={"Authorization": f"Bearer {tok}"})
        check(gone.status_code == 401, "access token of a revoked session refused at once")

        # Logout
        r = await sign_in(org_pid, "alice")
        ck = cookie_of(r)
        async with httpx.AsyncClient(timeout=20) as c:
            await c.post(f"{API}/api/auth/logout", headers={"X-Citadel-Refresh": "1"}, cookies={"citadel_refresh": ck})
        check((await refresh(ck)).status_code == 401, "logout ends the session")

        # Provider tokens are never accepted directly
        now = int(time.time())
        forged = jwt.encode({"iss": IDP, "aud": "citadel-acme", "sub": "alice-1", "iat": now, "exp": now + 300},
                            PEM, algorithm="RS256", headers={"kid": "k1"})
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.get(f"{API}/api/auth/me", headers={"Authorization": f"Bearer {forged}"})
        check(r.status_code == 401, "a provider token is not a Citadel session")
        # HS256 token signed with a wrong key / alg none
        nonetok = jwt.encode({"iss": "citadel", "typ": "access", "sub": str(uuid.uuid4()), "sid": str(uuid.uuid4()),
                              "exp": now + 300}, "wrong", algorithm="HS256")
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.get(f"{API}/api/auth/me", headers={"Authorization": f"Bearer {nonetok}"})
        check(r.status_code == 401, "forged Citadel token refused")
        # open redirect
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.get(f"{API}/api/auth/login/{org_pid}", params={"return_to": "//evil.example/x", "login_hint": "alice"})
            r = await c.get(r.headers["location"])
            r = await c.get(r.headers["location"])
        check(r.headers.get("location") == "/", "return_to cannot leave the application")
    finally:
        async with async_session() as db:
            with tenancy.system():
                await db.execute(delete(Organization).where(Organization.slug == "acme-sso"))
                await db.execute(delete(OrgInvitation).where(OrgInvitation.email.in_(emails)))
                await db.execute(delete(IdentityProvider).where(IdentityProvider.issuer == IDP))
                await db.execute(text("delete from audit_logs where user_id in (select id from users where email = any(:e))"), {"e": emails})
                await db.execute(delete(User).where(User.email.in_(emails)))
                await db.commit()
        server.should_exit = True
        await task
    print(f"\n{len(fails)} failure(s)")


asyncio.run(main())
