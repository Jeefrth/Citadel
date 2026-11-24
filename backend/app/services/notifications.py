"""Notifications (G4): in-app (bell) + external channels (email, Teams, webhook).

notify() writes in-app rows in the caller's transaction and schedules the
external dispatch in the background, so a slow SMTP server or webhook
never delays a user request. Channel secrets (SMTP password, webhook URL)
are encrypted like credentials (vault transit when enabled).
"""

import asyncio
import logging
import smtplib
import ssl
from datetime import datetime, timezone
from email.message import EmailMessage

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import async_session
from app.core.security import decrypt_value
from app.models.base import UserRole
from app.models.governance import Notification, NotificationChannel
from app.models.user import User

logger = logging.getLogger("citadel.notifications")

LEVELS = {"info": 0, "warning": 1, "critical": 2}

# Event catalogue (also used by the UI to subscribe channels)
EVENTS = {
    "approval.requested": "Demande de validation à traiter",
    "approval.decided": "Décision sur une de vos demandes",
    "command.alert": "Commande sous surveillance exécutée",
    "command.denied": "Commande refusée",
    "connect.denied": "Connexion refusée par une ACL",
    "rotation.failed": "Échec de rotation de mot de passe",
    "discovery.privileged": "Compte privilégié non géré découvert",
    "session.killed": "Session terminée par un administrateur",
    "access.expiring": "Règle d'accès bientôt expirée",
    "cloud.pending": "Nouvelles VM cloud à valider",
    "backup.failed": "Échec de la sauvegarde des comptes",
    "risk.found": "Nouveaux risques détectés",
    "test": "Message de test",
}

_background: set[asyncio.Task] = set()


async def admin_ids(db: AsyncSession) -> list:
    rows = await db.execute(select(User.id).where(User.role == UserRole.ADMIN, User.is_active.is_(True)))
    return [r[0] for r in rows.all()]


def _url(link: str | None) -> str | None:
    if not link:
        return None
    return link if link.startswith("http") else settings.PUBLIC_URL.rstrip("/") + link


async def notify(
    db: AsyncSession, event: str, title: str, body: str = "", link: str | None = None,
    recipients: list | None = None, level: str = "info",
) -> None:
    """In-app rows for recipients (default: admins) + background external dispatch.

    The caller commits the transaction (in-app rows are part of it).
    """
    if recipients is None:
        recipients = await admin_ids(db)
    recipients = list(dict.fromkeys(recipients))
    for uid in recipients:
        db.add(Notification(user_id=uid, event=event, level=level, title=title[:255], body=body, link=link))
    task = asyncio.create_task(_dispatch(event, title, body, link, recipients, level))
    _background.add(task)
    task.add_done_callback(_background.discard)


async def _dispatch(event: str, title: str, body: str, link: str | None, recipients: list, level: str) -> None:
    try:
        async with async_session() as db:
            channels = (await db.execute(
                select(NotificationChannel).where(NotificationChannel.is_active.is_(True))
            )).scalars().all()
            emails = []
            if recipients:
                emails = [r[0] for r in (await db.execute(
                    select(User.email).where(User.id.in_(recipients)))).all() if r[0] and "@" in r[0]]
            for ch in channels:
                if ch.events and event not in ch.events:
                    continue
                if LEVELS.get(level, 0) < LEVELS.get(ch.min_level, 0):
                    continue
                try:
                    await send_to_channel(ch, event, title, body, link, level, emails)
                    ch.last_sent_at = datetime.now(timezone.utc)
                    ch.last_error = None
                except Exception as e:  # noqa: BLE001
                    ch.last_error = f"{type(e).__name__}: {e}"[:500]
                    logger.warning("notification channel %s failed: %s", ch.name, ch.last_error)
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.exception("notification dispatch failed")


async def send_to_channel(ch: NotificationChannel, event: str, title: str, body: str,
                          link: str | None, level: str, recipient_emails: list[str] | None = None) -> None:
    secret = decrypt_value(ch.encrypted_secret) if ch.encrypted_secret else None
    url = _url(link)
    if ch.type == "email":
        cfg = ch.config or {}
        to = list(cfg.get("to") or [])
        if cfg.get("to_recipients", True) and recipient_emails:
            to += recipient_emails
        to = list(dict.fromkeys(to))
        if not to:
            raise ValueError("No email recipient")
        msg = EmailMessage()
        msg["Subject"] = f"[Citadel] {title}"
        msg["From"] = cfg.get("sender") or cfg.get("username") or "citadel@localhost"
        msg["To"] = ", ".join(to)
        msg.set_content(f"{body}\n\n{url or ''}".strip())
        await asyncio.get_running_loop().run_in_executor(None, _smtp_send, cfg, secret, msg)
    elif ch.type == "teams":
        if not secret:
            raise ValueError("Teams webhook URL missing")
        color = {"critical": "Attention", "warning": "Warning"}.get(level, "Accent")
        card = {
            "type": "AdaptiveCard", "version": "1.4",
            "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
            "body": [
                {"type": "TextBlock", "text": f"Citadel : {title}", "weight": "Bolder", "size": "Medium",
                 "wrap": True, "color": color},
                {"type": "TextBlock", "text": body or " ", "wrap": True},
            ],
            "actions": [{"type": "Action.OpenUrl", "title": "Ouvrir dans Citadel", "url": url}] if url else [],
        }
        payload = {"type": "message", "attachments": [
            {"contentType": "application/vnd.microsoft.card.adaptive", "content": card}]}
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(secret, json=payload)
            r.raise_for_status()
    elif ch.type == "webhook":
        if not secret:
            raise ValueError("Webhook URL missing")
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(secret, json={
                "source": "citadel", "event": event, "level": level, "title": title,
                "body": body, "link": url, "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            r.raise_for_status()
    else:
        raise ValueError(f"Unknown channel type {ch.type}")


def _smtp_send(cfg: dict, password: str | None, msg: EmailMessage) -> None:
    host, port = cfg.get("host"), int(cfg.get("port") or 587)
    if not host:
        raise ValueError("SMTP host missing")
    ctx = ssl.create_default_context()
    if port == 465:
        server = smtplib.SMTP_SSL(host, port, timeout=15, context=ctx)
    else:
        server = smtplib.SMTP(host, port, timeout=15)
    try:
        if port != 465 and cfg.get("starttls", True):
            server.starttls(context=ctx)
        if cfg.get("username") and password:
            server.login(cfg["username"], password)
        server.send_message(msg)
    finally:
        server.quit()
