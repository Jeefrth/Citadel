"""OIDC client (SaaS phase 3): authorization code flow with PKCE against any
provider (Entra, Google, Okta, generic OIDC).

- Discovery documents and JWKS are cached; unknown key ids trigger a refetch.
- state, nonce and the PKCE verifier live in Redis for 10 minutes and are
  consumed once (GETDEL): a callback can be used only once.
- The id_token is validated here (signature, issuer, audience, expiry, nonce,
  azp); nothing from the provider is trusted before that.
"""

import base64
import hashlib
import json
import secrets
import time
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx
import redis.asyncio as aioredis
from jose import jwt
from jose.exceptions import JOSEError

from app.core.config import settings

STATE_PREFIX = "citadel:oidc:state:"
STATE_TTL = 600
CACHE_TTL = 3600
ALLOWED_ALGS = ["RS256", "RS384", "RS512", "ES256", "ES384", "PS256"]
_http_timeout = httpx.Timeout(10.0)

_discovery: dict[str, tuple[float, dict]] = {}
_jwks: dict[str, tuple[float, dict]] = {}
_redis: aioredis.Redis | None = None


class OIDCError(Exception):
    """Sign-in failed; the message is safe to show."""


def _r() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.REDIS_URL)
    return _redis


def redirect_uri() -> str:
    return settings.PUBLIC_URL.rstrip("/") + "/api/auth/callback"


def _is_entra_multi(issuer: str) -> bool:
    """Entra 'organizations' / 'common' authority: the real issuer carries the user's tenant."""
    return any(f"login.microsoftonline.com/{t}/" in issuer + "/" for t in ("organizations", "common", "consumers"))


async def discovery(issuer: str) -> dict:
    issuer = issuer.rstrip("/")
    hit = _discovery.get(issuer)
    if hit and hit[0] > time.time():
        return hit[1]
    try:
        async with httpx.AsyncClient(timeout=_http_timeout) as c:
            r = await c.get(issuer + "/.well-known/openid-configuration")
            r.raise_for_status()
            doc = r.json()
    except (httpx.HTTPError, ValueError) as e:
        raise OIDCError(f"Fournisseur injoignable ({type(e).__name__})") from e
    # The document must describe this issuer (Entra multi-tenant: templated issuer)
    if not _is_entra_multi(issuer) and doc.get("issuer", "").rstrip("/") != issuer:
        raise OIDCError("Document de découverte d'un autre émetteur")
    for k in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
        if not str(doc.get(k, "")).startswith("https://") and not (settings.DEV_MODE or settings.OIDC_ALLOW_HTTP):
            raise OIDCError("Point d'accès du fournisseur non HTTPS")
    _discovery[issuer] = (time.time() + CACHE_TTL, doc)
    return doc


async def _jwks_for(uri: str, force: bool = False) -> dict:
    hit = _jwks.get(uri)
    if hit and hit[0] > time.time() and not force:
        return hit[1]
    async with httpx.AsyncClient(timeout=_http_timeout) as c:
        r = await c.get(uri)
        r.raise_for_status()
        keys = r.json()
    _jwks[uri] = (time.time() + CACHE_TTL, keys)
    return keys


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


@dataclass
class Flow:
    provider_id: str
    purpose: str            # login | reauth | link
    nonce: str
    verifier: str
    return_to: str = "/"
    user_id: str | None = None
    session_id: str | None = None


async def start(provider, purpose: str, return_to: str = "/", user_id=None, session_id=None,
                login_hint: str | None = None, force_login: bool = False) -> str:
    """Authorization URL for this provider; the flow state is kept server side."""
    doc = await discovery(provider.issuer)
    state, nonce, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(24), secrets.token_urlsafe(48)
    flow = Flow(str(provider.id), purpose, nonce, verifier, return_to, str(user_id) if user_id else None,
                str(session_id) if session_id else None)
    await _r().set(STATE_PREFIX + state, json.dumps(flow.__dict__), ex=STATE_TTL)
    params = {
        "response_type": "code",
        "client_id": provider.client_id,
        "redirect_uri": redirect_uri(),
        "scope": provider.scopes or "openid email profile",
        "state": state,
        "nonce": nonce,
        "code_challenge": _b64url(hashlib.sha256(verifier.encode()).digest()),
        "code_challenge_method": "S256",
    }
    if login_hint:
        params["login_hint"] = login_hint
    if force_login:   # re-authentication before a terminal
        params["prompt"] = "login"
        params["max_age"] = "0"
    return doc["authorization_endpoint"] + "?" + urlencode(params)


async def take_flow(state: str) -> Flow:
    raw = await _r().getdel(STATE_PREFIX + (state or ""))
    if not raw:
        raise OIDCError("Demande de connexion expirée ou déjà utilisée : recommencez")
    return Flow(**json.loads(raw))


async def finish(provider, flow: Flow, code: str, client_secret: str | None) -> dict:
    """Exchange the code and return the validated id_token claims."""
    doc = await discovery(provider.issuer)
    data = {"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri(),
            "code_verifier": flow.verifier, "client_id": provider.client_id}
    auth = None
    if client_secret:
        methods = doc.get("token_endpoint_auth_methods_supported") or ["client_secret_basic"]
        if "client_secret_post" in methods and "client_secret_basic" not in methods:
            data["client_secret"] = client_secret
        else:
            auth = (provider.client_id, client_secret)
    try:
        async with httpx.AsyncClient(timeout=_http_timeout) as c:
            r = await c.post(doc["token_endpoint"], data=data, auth=auth, headers={"Accept": "application/json"})
    except httpx.HTTPError as e:
        raise OIDCError(f"Fournisseur injoignable ({type(e).__name__})") from e
    if r.status_code != 200:
        try:
            err = r.json().get("error_description") or r.json().get("error")
        except ValueError:
            err = r.text[:200]
        raise OIDCError(f"Le fournisseur a refusé l'échange du code : {str(err)[:200]}")
    tokens = r.json()
    id_token = tokens.get("id_token")
    if not id_token:
        raise OIDCError("Le fournisseur n'a pas renvoyé d'id_token")
    return await validate_id_token(provider, doc, id_token, flow.nonce, tokens.get("access_token"))


async def validate_id_token(provider, doc: dict, id_token: str, nonce: str, access_token: str | None = None) -> dict:
    try:
        header = jwt.get_unverified_header(id_token)
    except JOSEError as e:
        raise OIDCError("id_token illisible") from e
    if header.get("alg") not in ALLOWED_ALGS:
        raise OIDCError("Algorithme de signature refusé")
    keys = await _jwks_for(doc["jwks_uri"])
    key = next((k for k in keys.get("keys", []) if k.get("kid") == header.get("kid")), None)
    if key is None:
        keys = await _jwks_for(doc["jwks_uri"], force=True)
        key = next((k for k in keys.get("keys", []) if k.get("kid") == header.get("kid")), None)
    if key is None:
        raise OIDCError("Clé de signature inconnue")
    try:
        claims = jwt.decode(id_token, key, algorithms=[header["alg"]], audience=provider.client_id,
                            access_token=access_token, options={"verify_iss": False, "verify_at_hash": bool(access_token)})
    except JOSEError as e:
        raise OIDCError(f"id_token invalide ({type(e).__name__})") from e
    iss = str(claims.get("iss", "")).rstrip("/")
    expected = provider.issuer.rstrip("/")
    if _is_entra_multi(expected):
        tid = claims.get("tid", "")
        if not tid or iss != f"https://login.microsoftonline.com/{tid}/v2.0":
            raise OIDCError("Émetteur inattendu")
    elif iss != expected:
        raise OIDCError("Émetteur inattendu")
    if not secrets.compare_digest(str(claims.get("nonce", "")), nonce):
        raise OIDCError("Réponse rejouée ou falsifiée (nonce)")
    aud = claims.get("aud")
    if isinstance(aud, list) and len(aud) > 1 and claims.get("azp") != provider.client_id:
        raise OIDCError("Destinataire inattendu")
    if not claims.get("sub"):
        raise OIDCError("Identité sans sujet")
    return claims


@dataclass
class ExternalIdentity:
    issuer: str
    subject: str
    email: str
    email_verified: bool
    name: str


def identity_from_claims(provider, claims: dict) -> ExternalIdentity:
    """Who signed in. Entra: subject = oid (sub depends on the application), the
    issuer is the user's tenant; the UPN counts as a verified address only for
    a member of the tenant (not a #EXT# guest)."""
    iss = str(claims["iss"]).rstrip("/")
    name = str(claims.get("name") or "")
    if provider.kind == "entra":
        subject = str(claims.get("oid") or claims["sub"])
        upn = str(claims.get("preferred_username") or claims.get("upn") or "").lower()
        verified = bool(upn) and "#ext#" not in upn and "@" in upn
        email = upn if verified else ""
        return ExternalIdentity(iss, subject, email, verified, name or email)
    email = str(claims.get("email") or "").lower()
    verified = claims.get("email_verified") in (True, "true")
    return ExternalIdentity(iss, str(claims["sub"]), email, bool(email) and verified, name or email)


def reset_caches() -> None:
    _discovery.clear()
    _jwks.clear()
