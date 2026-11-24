"""Risk detection (lot 7): periodic checks on accounts, users and keys.

Each finding has a stable key (check + object), so it keeps its first-seen
date, disappears by itself once fixed (resolved), or can be ignored by an
admin with a reason. New high / medium findings notify the admins.
"""

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.base import UserRole
from app.models.identity import UserSSHKey
from app.models.pam import AccessKey, AccessPolicy, Account, Application, DiscoveredAccount, RiskFinding
from app.models.server import Server
from app.models.settings import AppSetting
from app.models.user import User

LAST_SCAN = "_risk_last_scan"
SCAN_EVERY = timedelta(hours=24)
SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}


@dataclass
class Found:
    key: str
    category: str
    severity: str
    title: str
    detail: str = ""
    link: str | None = None


async def _settings(db) -> tuple[int, int]:
    from app.services.settings_service import get_setting_int
    return (await get_setting_int(db, "risk_secret_max_age_days") or 90,
            await get_setting_int(db, "risk_dormant_days") or 60)


async def detect(db: AsyncSession, now: datetime) -> list[Found]:
    max_age, dormant = await _settings(db)
    out: list[Found] = []
    rows = (await db.execute(select(Account, Server).join(Server, Server.id == Account.server_id))).all()
    managed = {(a.server_id, a.username) for a, _ in rows}
    for a, s in rows:
        where = f"{a.username} sur {s.name}"
        link = f"/servers/{s.id}"
        if not a.is_active:
            continue
        has_password = a.credential is not None and a.credential.encrypted_password and not a.use_cert
        if has_password:
            ref = a.last_rotated_at or a.created_at
            if ref and ref < now - timedelta(days=max_age):
                out.append(Found(f"secret_old:{a.id}", "secret_old", "high" if a.privileged else "medium",
                                 f"Mot de passe de plus de {max_age} jours : {where}",
                                 f"Dernier changement : {ref:%d/%m/%Y}" if a.last_rotated_at else "Jamais changé par Citadel", link))
            if a.privileged and not a.rotation_enabled:
                out.append(Found(f"no_rotation:{a.id}", "no_rotation", "medium",
                                 f"Compte à privilèges sans rotation : {where}", "Activer la rotation automatique.", link))
        if a.verify_status in ("failed", "error"):
            out.append(Found(f"verify_failed:{a.id}", "verify_failed", "high" if a.privileged else "medium",
                             f"Le secret ne fonctionne plus : {where}", (a.verify_message or "")[:500], link))
        if a.credential is None and not a.use_cert:
            out.append(Found(f"no_secret:{a.id}", "no_secret", "low", f"Compte sans secret : {where}", "", link))

    for d, s in (await db.execute(select(DiscoveredAccount, Server).join(Server, Server.id == DiscoveredAccount.server_id)
                                  .where(DiscoveredAccount.privileged.is_(True), DiscoveredAccount.status == "new"))).all():
        if (d.server_id, d.username) not in managed:
            out.append(Found(f"unmanaged_privileged:{d.id}", "unmanaged_privileged", "high",
                             f"Compte à privilèges non géré : {d.username} sur {s.name}",
                             "Le gérer dans Citadel ou l'ignorer depuis la collecte des comptes.", f"/servers/{s.id}"))

    for u in (await db.execute(select(User).where(User.is_active.is_(True)))).scalars().all():
        if u.entra_object_id.startswith("dev-mode"):
            continue
        last = u.last_login
        if (last is None and u.created_at and u.created_at < now - timedelta(days=dormant)) or (last and last < now - timedelta(days=dormant)):
            out.append(Found(f"dormant_user:{u.id}", "dormant_user", "high" if u.role == UserRole.ADMIN else "medium",
                             f"Utilisateur inactif depuis plus de {dormant} jours : {u.display_name}",
                             f"Rôle {u.role.value}. Désactiver le compte s'il n'est plus utilisé.", "/settings?tab=users"))

    stale = now - timedelta(days=90)
    for k, u in (await db.execute(select(AccessKey, User).join(User, User.id == AccessKey.user_id)
                                  .where(AccessKey.is_active.is_(True)))).all():
        if k.expires_at is None:
            out.append(Found(f"key_no_expiry:{k.id}", "access_key", "medium",
                             f"Clé d'accès sans expiration : {k.name} ({u.display_name})", "", "/account"))
        elif (k.last_used_at or k.created_at) and (k.last_used_at or k.created_at) < stale:
            out.append(Found(f"key_unused:{k.id}", "access_key", "low",
                             f"Clé d'accès inutilisée depuis 90 jours : {k.name} ({u.display_name})", "", "/account"))
    for k, u in (await db.execute(select(UserSSHKey, User).join(User, User.id == UserSSHKey.user_id))).all():
        if (k.last_used_at or k.created_at) < stale:
            out.append(Found(f"ssh_key_unused:{k.id}", "ssh_key", "low",
                             f"Clé SSH inutilisée depuis 90 jours : {k.name} ({u.display_name})", k.fingerprint, "/account"))
    for app in (await db.execute(select(Application).where(Application.is_active.is_(True)))).scalars().all():
        if not app.allowed_ips:
            out.append(Found(f"app_any_ip:{app.id}", "application", "medium",
                             f"Application sans restriction d'IP : {app.name}", "Limiter les adresses autorisées.", "/settings?tab=applications"))

    for p in (await db.execute(select(AccessPolicy).where(AccessPolicy.is_active.is_(True)))).scalars().all():
        broad = "@ALL" in (p.accounts or []) and "execute" in (p.actions or []) and p.valid_until is None
        if broad and not (p.servers or p.nodes or p.labels):
            out.append(Found(f"broad_policy:{p.id}", "policy", "medium",
                             f"Règle d'accès très large : {p.name}",
                             "Tous les comptes, droit d'exécuter, sans fin de validité ni serveur ciblé.", "/access"))
    return out


async def scan(db: AsyncSession, now: datetime | None = None, notify_new: bool = True) -> dict:
    now = now or datetime.now(timezone.utc)
    found = {f.key: f for f in await detect(db, now)}
    existing = {r.key: r for r in (await db.execute(select(RiskFinding))).scalars().all()}
    new_serious = []
    for key, f in found.items():
        row = existing.get(key)
        if row is None:
            row = RiskFinding(key=key, first_seen=now)
            db.add(row)
            if f.severity in ("high", "medium"):
                new_serious.append(f)
        elif row.resolved_at is not None:
            row.resolved_at = None  # came back
            if f.severity in ("high", "medium") and not row.ignored:
                new_serious.append(f)
        row.category, row.severity, row.title = f.category, f.severity, f.title[:255]
        row.detail, row.link, row.last_seen = (f.detail or "")[:1000], f.link, now
    resolved = 0
    for key, row in existing.items():
        if key not in found and row.resolved_at is None:
            row.resolved_at = now
            resolved += 1
    setting = (await db.execute(select(AppSetting).where(AppSetting.key == LAST_SCAN))).scalar_one_or_none()
    if setting is None:
        db.add(AppSetting(key=LAST_SCAN, value=now.isoformat(), description="Dernière analyse des risques"))
    else:
        setting.value = now.isoformat()
    if notify_new and new_serious:
        from app.services.notifications import notify
        high = sum(1 for f in new_serious if f.severity == "high")
        await notify(db, "risk.found", f"{len(new_serious)} nouveau(x) risque(s) détecté(s)" + (f", dont {high} élevé(s)" if high else ""),
                     "\n".join(f"- {f.title}" for f in new_serious[:10]), link="/risks",
                     level="warning" if high else "info")
    await db.commit()
    return {"open": len(found), "new": len(new_serious), "resolved": resolved}


async def scheduled(db: AsyncSession, now: datetime) -> int:
    setting = (await db.execute(select(AppSetting).where(AppSetting.key == LAST_SCAN))).scalar_one_or_none()
    if setting is not None and datetime.fromisoformat(setting.value) + SCAN_EVERY > now:
        return 0
    await scan(db, now)
    return 1
