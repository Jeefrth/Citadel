"""Sign-in through OIDC providers and Citadel sessions (SaaS phase 3).

Browser flow: GET /api/auth/login/{provider} -> provider -> GET /api/auth/callback
-> refresh cookie set, back to the app, which calls POST /api/auth/refresh for
its access token. Re-authentication (before a terminal) and linking another
provider run the same flow in a popup that reports back with postMessage.
"""

import html
import json
import uuid
from datetime import datetime, timezone
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_identity
from app.core.config import settings
from app.core.database import get_db
from app.core.governance import client_ip
from app.models.auth import AuthSession, IdentityProvider, UserIdentity
from app.models.user import User
from app.services import login as login_svc
from app.services import oidc, sessions

router = APIRouter()
REFRESH_HEADER = "X-Citadel-Refresh"   # custom header: a cross-site form cannot send it (CSRF)


def _provider_read(p: IdentityProvider) -> dict:
    return {"id": str(p.id), "name": p.name, "kind": p.kind}


def _safe_return(path: str | None) -> str:
    """Only a path of this application (no open redirect)."""
    p = (path or "/").strip()
    if not p.startswith("/") or p.startswith("//") or "\\" in p or "\n" in p or "\r" in p:
        return "/"
    return p[:500]


async def _active_provider(db: AsyncSession, provider_id) -> IdentityProvider:
    try:
        p = await db.get(IdentityProvider, uuid.UUID(str(provider_id)))
    except ValueError:
        p = None
    if p is None or not p.is_active:
        raise HTTPException(status_code=404, detail="Provider not found")
    if p.org_id is not None:
        from app.models.organization import Organization
        org = await db.get(Organization, p.org_id)
        if org is None or not org.is_active:
            raise HTTPException(status_code=404, detail="Provider not found")
    return p


# ── Sign-in page ──

@router.get("/providers")
async def providers(db: AsyncSession = Depends(get_db)):
    """Platform providers (buttons of the sign-in page). Public."""
    return [_provider_read(p) for p in await login_svc.providers_for_login(db)]


class DiscoverIn(BaseModel):
    value: str = Field(min_length=1, max_length=255)   # e-mail or organisation identifier


@router.post("/discover")
async def discover(data: DiscoverIn, db: AsyncSession = Depends(get_db)):
    """Company SSO from an address or an organisation identifier. Public; an
    empty list when nothing matches (no hint about organisations)."""
    return [_provider_read(p) for p in await login_svc.discover(db, data.value)]


@router.get("/login/{provider_id}")
async def login(provider_id: str, return_to: str = "/", login_hint: str | None = None,
                db: AsyncSession = Depends(get_db)):
    p = await _active_provider(db, provider_id)
    try:
        url = await oidc.start(p, "login", _safe_return(return_to), login_hint=(login_hint or "")[:255] or None)
    except oidc.OIDCError as e:
        return RedirectResponse(f"/?auth_error={quote(str(e))}", status_code=302)
    return RedirectResponse(url, status_code=302)


# ── Provider callback ──

def _popup_result(kind: str, ok: bool, message: str = "") -> HTMLResponse:
    """Page shown in the popup (re-authentication, linking): tells the app and closes."""
    origin = settings.PUBLIC_URL.rstrip("/")
    payload = json.dumps({"type": f"citadel-{kind}", "ok": ok, "message": message})
    body = f"""<!doctype html><meta charset="utf-8"><title>Citadel</title>
<p style="font-family:sans-serif">{html.escape(message or ("Terminé, vous pouvez fermer cette fenêtre." if ok else "Échec."))}</p>
<script>try {{ window.opener && window.opener.postMessage({payload}, {json.dumps(origin)}); }} catch (e) {{}}
setTimeout(function () {{ window.close(); }}, {300 if ok else 4000});</script>"""
    return HTMLResponse(body, headers={"Cache-Control": "no-store"})


@router.get("/callback")
async def callback(request: Request, state: str = "", code: str = "", error: str = "", error_description: str = "",
                   db: AsyncSession = Depends(get_db)):
    ip = client_ip(request.client.host if request.client else None, request.headers)
    ua = request.headers.get("user-agent")
    try:
        flow = await oidc.take_flow(state)
    except oidc.OIDCError as e:
        return RedirectResponse(f"/?auth_error={quote(str(e))}", status_code=302)
    popup = flow.purpose in ("reauth", "link")

    def fail(msg: str):
        if popup:
            return _popup_result(flow.purpose, False, msg)
        return RedirectResponse(f"/?auth_error={quote(msg)}", status_code=302)

    if error:
        return fail(f"Connexion annulée ou refusée par le fournisseur ({error})"[:300])
    try:
        provider = await _active_provider(db, flow.provider_id)
        claims = await oidc.finish(provider, flow, code, await login_svc.client_secret(db, provider))
        ident = oidc.identity_from_claims(provider, claims)
    except HTTPException:
        return fail("Fournisseur de connexion indisponible")
    except oidc.OIDCError as e:
        return fail(str(e))

    if flow.purpose == "reauth":
        return await _finish_reauth(db, flow, provider, ident, claims)
    if flow.purpose == "link":
        return await _finish_link(db, flow, provider, ident)

    provider_name = provider.name
    try:
        user = await login_svc.resolve_person(db, provider, ident)
    except login_svc.LoginRefused as e:
        from app.services.devices import record_denied
        await db.rollback()
        await record_denied(db, None, ip, f"{provider_name} : {e}"[:255], "sso", ua)
        await db.commit()
        return fail(str(e))
    s, refresh = await sessions.create(db, user.id, provider.id, ip, ua)
    await db.commit()
    resp = RedirectResponse(_safe_return(flow.return_to), status_code=302)
    resp.set_cookie(value=refresh, **sessions.cookie_kwargs())
    return resp


async def _finish_reauth(db, flow, provider, ident, claims) -> HTMLResponse:
    """The same person signed in again: the session's auth_time moves forward."""
    s = await db.get(AuthSession, uuid.UUID(flow.session_id)) if flow.session_id else None
    link = (await db.execute(select(UserIdentity).where(
        UserIdentity.issuer == ident.issuer, UserIdentity.subject == ident.subject))).scalar_one_or_none()
    if s is None or s.revoked_at is not None or link is None or str(link.user_id) != flow.user_id \
            or str(s.user_id) != flow.user_id:
        return _popup_result("reauth", False, "Ce n'est pas le compte de la session en cours")
    auth_time = claims.get("auth_time")
    now = datetime.now(timezone.utc)
    when = datetime.fromtimestamp(int(auth_time), timezone.utc) if auth_time else now
    if (now - when).total_seconds() > 300:   # the provider did not actually ask again
        return _popup_result("reauth", False, "Le fournisseur n'a pas redemandé la connexion")
    s.auth_time, s.provider_id = min(when, now), provider.id
    await db.commit()
    return _popup_result("reauth", True)


async def _finish_link(db, flow, provider, ident) -> HTMLResponse:
    from app.models.audit import AuditLog
    link = (await db.execute(select(UserIdentity).where(
        UserIdentity.issuer == ident.issuer, UserIdentity.subject == ident.subject))).scalar_one_or_none()
    if link is not None and str(link.user_id) != flow.user_id:
        return _popup_result("link", False, "Ce compte est déjà lié à une autre personne")
    if not login_svc.domain_allowed(provider, ident):
        return _popup_result("link", False, "Adresse non autorisée par ce fournisseur")
    if link is None:
        db.add(UserIdentity(user_id=uuid.UUID(flow.user_id), provider_id=provider.id, issuer=ident.issuer,
                            subject=ident.subject, email=ident.email, email_verified=ident.email_verified,
                            last_login_at=datetime.now(timezone.utc)))
        db.add(AuditLog(user_id=uuid.UUID(flow.user_id), action="identity.link", result=f"{provider.name} {ident.email}"))
        await db.commit()
    return _popup_result("link", True, "Compte lié.")


# ── Session ──

def _check_refresh_header(request: Request) -> None:
    if request.headers.get(REFRESH_HEADER) != "1":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Missing refresh header")


@router.post("/refresh")
async def refresh(request: Request, db: AsyncSession = Depends(get_db)):
    """Access token from the refresh cookie (rotated)."""
    _check_refresh_header(request)
    try:
        s, new = await sessions.refresh(db, request.cookies.get(sessions.COOKIE, ""))
    except sessions.SessionError:
        await db.commit()   # a detected reuse revoked the session
        resp = JSONResponse({"detail": "Not authenticated"}, status_code=401)
        resp.delete_cookie(sessions.COOKIE, path="/api/auth")
        return resp
    token, ttl = await sessions.access_token(db, s)
    await db.commit()
    resp = JSONResponse({"access_token": token, "expires_in": ttl, "auth_time": int(s.auth_time.timestamp())},
                        headers={"Cache-Control": "no-store"})
    if new is not None:
        resp.set_cookie(value=new, **sessions.cookie_kwargs())
    return resp


@router.post("/logout")
async def logout(request: Request, db: AsyncSession = Depends(get_db)):
    _check_refresh_header(request)
    try:
        s, _ = await sessions.refresh(db, request.cookies.get(sessions.COOKIE, ""))
        await sessions.revoke(db, s)
    except sessions.SessionError:
        pass
    await db.commit()
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(sessions.COOKIE, path="/api/auth")
    return resp


async def _popup_url(db, user: User, provider: IdentityProvider, purpose: str, force: bool) -> dict:
    sid = getattr(user, "_session_id", None)
    if sid is None:
        raise HTTPException(status_code=403, detail="Possible seulement depuis une session ouverte dans le navigateur")
    url = await oidc.start(provider, purpose, "/", user_id=user.id, session_id=sid, force_login=force)
    return {"url": url}


@router.post("/reauth")
async def reauth(db: AsyncSession = Depends(get_db), user: User = Depends(get_identity)):
    """URL for the re-authentication popup, at the provider of the current session."""
    s = await db.get(AuthSession, getattr(user, "_session_id", None)) if getattr(user, "_session_id", None) else None
    if s is None or s.provider_id is None:
        raise HTTPException(status_code=403, detail="Possible seulement depuis une session ouverte dans le navigateur")
    provider = await _active_provider(db, s.provider_id)
    try:
        return await _popup_url(db, user, provider, "reauth", True)
    except oidc.OIDCError as e:
        raise HTTPException(status_code=502, detail=str(e))


# ── Mon compte: identities and sessions ──

@router.get("/identities")
async def my_identities(db: AsyncSession = Depends(get_db), user: User = Depends(get_identity)):
    rows = (await db.execute(select(UserIdentity).where(UserIdentity.user_id == user.id)
                             .order_by(UserIdentity.created_at))).scalars().all()
    return [{"id": str(i.id), "provider": _provider_read(i.provider) if i.provider else None, "email": i.email,
             "created_at": i.created_at, "last_login_at": i.last_login_at} for i in rows]


@router.get("/linkable")
async def linkable_providers(db: AsyncSession = Depends(get_db), user: User = Depends(get_identity)):
    """Providers this person may link: platform ones and the SSO of their organisations."""
    from app.models.organization import OrgMembership
    orgs = select(OrgMembership.org_id).where(OrgMembership.user_id == user.id, OrgMembership.is_active.is_(True))
    rows = (await db.execute(select(IdentityProvider).where(
        IdentityProvider.is_active.is_(True),
        (IdentityProvider.org_id.is_(None)) | (IdentityProvider.org_id.in_(orgs))))).scalars().all()
    return [_provider_read(p) for p in rows]


@router.post("/link/{provider_id}")
async def link(provider_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_identity)):
    if str(provider_id) not in {p["id"] for p in await linkable_providers(db, user)}:
        raise HTTPException(status_code=404, detail="Provider not found")
    provider = await _active_provider(db, provider_id)
    try:
        return await _popup_url(db, user, provider, "link", True)
    except oidc.OIDCError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.delete("/identities/{identity_id}", status_code=204)
async def unlink(identity_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_identity)):
    from app.models.audit import AuditLog
    rows = (await db.execute(select(UserIdentity).where(UserIdentity.user_id == user.id))).scalars().all()
    target = next((i for i in rows if i.id == identity_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="Identity not found")
    if len(rows) <= 1:
        raise HTTPException(status_code=400, detail="Impossible de retirer votre seul moyen de connexion")
    db.add(AuditLog(user_id=user.id, action="identity.unlink", result=f"{target.provider.name if target.provider else '?'} {target.email}"))
    await db.delete(target)
    await db.commit()


@router.get("/sessions")
async def my_sessions(db: AsyncSession = Depends(get_db), user: User = Depends(get_identity)):
    now = datetime.now(timezone.utc)
    rows = (await db.execute(select(AuthSession).where(
        AuthSession.user_id == user.id, AuthSession.revoked_at.is_(None), AuthSession.expires_at > now)
        .order_by(AuthSession.last_used_at.desc()))).scalars().all()
    from app.services.devices import device_label
    return [{"id": str(s.id), "created_at": s.created_at, "last_used_at": s.last_used_at, "expires_at": s.expires_at,
             "ip_address": s.ip_address, "device": device_label(s.user_agent) if s.user_agent else None,
             "current": s.id == getattr(user, "_session_id", None)} for s in rows]


@router.delete("/sessions/{session_id}", status_code=204)
async def end_session(session_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_identity)):
    s = await db.get(AuthSession, session_id)
    if s is None or s.user_id != user.id:
        raise HTTPException(status_code=404, detail="Session not found")
    await sessions.revoke(db, s)
    await db.commit()
