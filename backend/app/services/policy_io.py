"""Access policy import / export (lot 6).

Portable JSON: references by name (users by e-mail, groups / servers by name,
nodes by path "Prod/Web"), so a file can move between Citadel instances. An
import is all-or-nothing per policy: one unknown reference and that policy is
reported, not created half-way. dry_run shows what would happen.
"""

from datetime import datetime

from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pam import AccessPolicy, Node, UserGroup
from app.models.server import Server
from app.models.user import User
from app.schemas.pam import AccessPolicyCreate

FORMAT_VERSION = 1


async def _node_paths(db: AsyncSession) -> dict:
    nodes = {n.id: n for n in (await db.execute(select(Node))).scalars().all()}

    def path(n) -> str:
        parts, seen = [], set()
        while n is not None and n.id not in seen:
            seen.add(n.id)
            parts.append(n.name)
            n = nodes.get(n.parent_id)
        return "/".join(reversed(parts))
    return {nid: path(n) for nid, n in nodes.items()}


def _user_ref(u: User) -> str:
    """E-mail when known, else the Entra object id (users with no e-mail claim)."""
    return u.email or f"oid:{u.entra_object_id}"


async def export_policies(db: AsyncSession) -> dict:
    paths = await _node_paths(db)
    out = []
    for p in (await db.execute(select(AccessPolicy).order_by(AccessPolicy.name))).scalars().all():
        out.append({
            "name": p.name, "description": p.description, "is_active": p.is_active,
            "valid_from": p.valid_from.isoformat() if p.valid_from else None,
            "valid_until": p.valid_until.isoformat() if p.valid_until else None,
            "actions": p.actions or [], "accounts": p.accounts or [], "labels": p.labels or [],
            "users": sorted(_user_ref(u) for u in p.users), "groups": sorted(g.name for g in p.groups),
            "servers": sorted(s.name for s in p.servers), "nodes": sorted(paths.get(n.id, n.name) for n in p.nodes),
        })
    return {"citadel": "access-policies", "version": FORMAT_VERSION, "policies": out}


async def import_policies(db: AsyncSession, payload: dict, *, overwrite: bool, dry_run: bool, actor_id) -> dict:
    if payload.get("citadel") != "access-policies" or payload.get("version") != FORMAT_VERSION:
        raise ValueError("Fichier non reconnu (attendu : export de règles d'accès Citadel, version 1)")
    items = payload.get("policies")
    if not isinstance(items, list) or len(items) > 2000:
        raise ValueError("« policies » doit être une liste (2000 au plus)")

    users = {}
    from app.services.members import members_query
    for u in (await db.execute(members_query(active_only=False))).scalars().all():
        users[f"oid:{u.entra_object_id}".lower()] = u
        if u.email:
            users[u.email.lower()] = u
    groups = {g.name: g for g in (await db.execute(select(UserGroup))).scalars().all()}
    servers = {s.name: s for s in (await db.execute(select(Server))).scalars().all()}
    nodes_by_path = {path: nid for nid, path in (await _node_paths(db)).items()}
    node_objs = {n.id: n for n in (await db.execute(select(Node))).scalars().all()}
    existing = {p.name: p for p in (await db.execute(select(AccessPolicy))).scalars().all()}

    report = {"created": [], "updated": [], "skipped": [], "errors": []}
    seen = set()
    for raw in items:
        name = str((raw or {}).get("name", "")).strip()
        problems = []
        if not name:
            report["errors"].append({"name": "(sans nom)", "problems": ["nom manquant"]})
            continue
        if name in seen:
            report["errors"].append({"name": name, "problems": ["nom en double dans le fichier"]})
            continue
        seen.add(name)
        try:
            data = AccessPolicyCreate(
                name=name, description=raw.get("description"), is_active=raw.get("is_active", True),
                valid_from=raw.get("valid_from"), valid_until=raw.get("valid_until"),
                actions=raw.get("actions") or ["connect"], accounts=raw.get("accounts") or ["@ALL"],
                labels=raw.get("labels") or [],
            )
        except ValidationError as e:
            report["errors"].append({"name": name, "problems": [err["msg"] for err in e.errors()]})
            continue
        if data.valid_from and data.valid_until and data.valid_until <= data.valid_from:
            problems.append("fin de validité avant le début")

        def resolve(values, table, label, key=lambda v: v):
            found = []
            for v in values or []:
                obj = table.get(key(str(v)))
                if obj is None:
                    problems.append(f"{label} inconnu : {v}")
                else:
                    found.append(obj)
            return found
        u = resolve(raw.get("users"), users, "utilisateur", key=str.lower)
        g = resolve(raw.get("groups"), groups, "groupe")
        s = resolve(raw.get("servers"), servers, "serveur")
        n = [node_objs[nid] for nid in resolve(raw.get("nodes"), nodes_by_path, "nœud")]
        if problems:
            report["errors"].append({"name": name, "problems": problems})
            continue

        policy = existing.get(name)
        if policy is not None and not overwrite:
            report["skipped"].append(name)
            continue
        report["updated" if policy is not None else "created"].append(name)
        if dry_run:
            continue
        if policy is None:
            policy = AccessPolicy(name=name, created_by=actor_id)
            db.add(policy)
        policy.description, policy.is_active = data.description, data.is_active
        if policy.valid_until != data.valid_until:
            policy.expiry_notified_at = None
        policy.valid_from, policy.valid_until = data.valid_from, data.valid_until
        policy.actions, policy.accounts, policy.labels = data.actions, data.accounts, data.labels
        policy.users, policy.groups, policy.servers, policy.nodes = u, g, s, n
    return report
