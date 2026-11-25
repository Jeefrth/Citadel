"""Kubernetes rights (lot 8): which clusters, namespaces and actions a user has.

Like server access: admins have everything; others get what active K8s
policies give them (directly or through a group), capped by their role
(viewer: view and logs only). An invisible cluster answers 404.
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.base import UserRole
from app.models.kubernetes import K8S_ACTIONS, K8sCluster, K8sPolicy
from app.models.pam import user_group_members
from app.models.user import User
from app.services.k8s import ns_allowed

VIEWER_ACTIONS = {"view", "logs"}


@dataclass
class ClusterGrant:
    """Rights on one cluster. Each policy stays a separate (actions, namespaces)
    rule: an action is allowed in a namespace only if ONE rule gives both (two
    policies "exec on dev" + "view on *" must not give exec everywhere).
    actions / namespaces are unions, for display only."""
    actions: set[str] = field(default_factory=set)
    namespaces: set[str] = field(default_factory=set)
    policies: set[str] = field(default_factory=set)
    rules: list[tuple[frozenset, frozenset]] = field(default_factory=list)

    def can(self, action: str, ns: str | None = None) -> bool:
        return any(action in acts and (ns is None or ns_allowed(set(nss), ns)) for acts, nss in self.rules)

    def sees_namespace(self, ns: str) -> bool:
        return self.can("view", ns)


FULL = ClusterGrant(actions=set(K8S_ACTIONS), namespaces={"*"}, policies={"admin"},
                    rules=[(frozenset(K8S_ACTIONS), frozenset({"*"}))])


async def grants(db: AsyncSession, user: User) -> dict[str, ClusterGrant] | None:
    if user.role == UserRole.ADMIN:
        return None
    now = datetime.now(timezone.utc)
    groups = {str(r[0]) for r in (await db.execute(
        select(user_group_members.c.group_id).where(user_group_members.c.user_id == user.id))).all()}
    out: dict[str, ClusterGrant] = {}
    for p in (await db.execute(select(K8sPolicy).where(K8sPolicy.is_active.is_(True)))).scalars().all():
        if p.valid_from and p.valid_from > now or p.valid_until and p.valid_until < now:
            continue
        if str(user.id) not in (p.user_ids or []) and not groups & set(p.group_ids or []):
            continue
        actions = set(p.actions or []) & set(K8S_ACTIONS)
        if user.role == UserRole.VIEWER:
            actions &= VIEWER_ACTIONS
        if "exec" in actions or "manage" in actions or "logs" in actions:
            actions.add("view")
        if not actions:
            continue
        for cid in p.cluster_ids or []:
            g = out.setdefault(str(cid), ClusterGrant())
            g.actions |= actions
            g.namespaces |= set(p.namespaces or [])
            g.policies.add(p.name)
            g.rules.append((frozenset(actions), frozenset(p.namespaces or [])))
    return out


async def require_cluster(db: AsyncSession, user: User, cluster_id: uuid.UUID | str,
                          action: str = "view", ns: str | None = None) -> tuple[K8sCluster, ClusterGrant]:
    cluster = await db.get(K8sCluster, uuid.UUID(str(cluster_id)))
    g = await grants(db, user)
    grant = FULL if g is None else g.get(str(cluster_id)) if cluster else None
    if cluster is None or grant is None or not cluster.is_active:
        raise HTTPException(status_code=404, detail="Cluster not found")
    if ns is not None and not grant.sees_namespace(ns):
        raise HTTPException(status_code=404, detail="Namespace not found")
    if not grant.can(action, ns):
        raise HTTPException(status_code=403, detail=f"Action '{action}' not granted"
                                                    + (f" in namespace '{ns}'" if ns else " on this cluster"))
    return cluster, grant
