"""Kubernetes API (lot 8): clusters and policies (admin / "kubernetes" permission),
browsing, logs and actions for users, within their K8s policies."""

import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user, require_perm
from app.core.database import get_db
from app.core.security import encrypt_value
from app.models.audit import AuditLog
from app.models.kubernetes import K8S_ACTIONS, K8sCluster, K8sPolicy
from app.models.user import User
from app.services import k8s, k8s_access

router = APIRouter()
manage = require_perm("kubernetes")
DNS_NAME = re.compile(r"^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$")


def _name(value: str, what: str) -> str:
    if not DNS_NAME.match(value or ""):
        raise HTTPException(status_code=400, detail=f"Nom de {what} invalide")
    return value


def _err(e: k8s.K8sError):
    raise HTTPException(status_code=e.status, detail=str(e))


async def _audit(db, user: User, request: Request | None, action: str, result: str, status: str = "success"):
    db.add(AuditLog(user_id=user.id, action=action, status=status, result=result[:500],
                    ip_address=getattr(request.state, "client_ip", None) if request else None))
    await db.commit()


# ── clusters (management) ──

class ClusterIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=500)
    api_url: str = Field(pattern=r"^https?://[^\s/]+(:\d+)?/?$")
    ca_cert: str | None = Field(default=None, max_length=20000)
    skip_tls_verify: bool = False
    token: str | None = Field(default=None, max_length=20000)   # omitted on update = unchanged
    node_id: uuid.UUID | None = None
    zone_id: uuid.UUID | None = None
    tags: dict[str, str] = Field(default_factory=dict)
    is_active: bool = True

    @field_validator("ca_cert")
    @classmethod
    def _pem(cls, v):
        if v and "BEGIN CERTIFICATE" not in v:
            raise ValueError("ca_cert must be a PEM certificate")
        return v  # None = unchanged on update, "" = remove


def _cluster_read(c: K8sCluster, grant: k8s_access.ClusterGrant | None = None) -> dict:
    out = {"id": str(c.id), "name": c.name, "description": c.description, "api_url": c.api_url,
           "has_ca_cert": bool(c.ca_cert), "skip_tls_verify": c.skip_tls_verify, "has_token": bool(c.encrypted_token),
           "node_id": str(c.node_id) if c.node_id else None, "zone_id": str(c.zone_id) if c.zone_id else None,
           "tags": c.tags or {}, "is_active": c.is_active, "version": c.version, "last_check_at": c.last_check_at,
           "last_check_status": c.last_check_status, "last_check_message": c.last_check_message}
    if grant is not None:
        out["actions"] = sorted(grant.actions)
        out["namespaces"] = sorted(grant.namespaces)
    return out


@router.get("/k8s/clusters")
async def list_clusters(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """Clusters the user may see, with their actions and namespaces."""
    g = await k8s_access.grants(db, user)
    rows = (await db.execute(select(K8sCluster).order_by(K8sCluster.name))).scalars().all()
    from app.core.auth import has_perm
    if g is None:
        return [_cluster_read(c, k8s_access.FULL) for c in rows]
    show_all = has_perm(user, "kubernetes")
    return [_cluster_read(c, g.get(str(c.id), k8s_access.ClusterGrant())) for c in rows
            if (str(c.id) in g and c.is_active) or show_all]


@router.post("/k8s/clusters", status_code=201)
async def create_cluster(data: ClusterIn, request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(manage)):
    if (await db.execute(select(K8sCluster.id).where(K8sCluster.name == data.name))).first():
        raise HTTPException(status_code=409, detail="A cluster with this name already exists")
    c = K8sCluster(**data.model_dump(exclude={"token", "ca_cert"}), ca_cert=data.ca_cert or None)
    if data.token:
        c.encrypted_token = encrypt_value(data.token.strip())
    db.add(c)
    await _audit(db, user, request, "k8s.cluster.create", f"{c.name} {c.api_url}")
    return _cluster_read(c)


@router.patch("/k8s/clusters/{cluster_id}")
async def update_cluster(cluster_id: uuid.UUID, data: ClusterIn, request: Request, db: AsyncSession = Depends(get_db),
                         user: User = Depends(manage)):
    c = await db.get(K8sCluster, cluster_id)
    if not c:
        raise HTTPException(status_code=404, detail="Cluster not found")
    for k, v in data.model_dump(exclude={"token", "ca_cert"}).items():
        setattr(c, k, v)
    if data.ca_cert is not None:
        c.ca_cert = data.ca_cert or None  # "" removes it
    if data.token:
        c.encrypted_token = encrypt_value(data.token.strip())
    await _audit(db, user, request, "k8s.cluster.update", c.name)
    return _cluster_read(c)


@router.delete("/k8s/clusters/{cluster_id}", status_code=204)
async def delete_cluster(cluster_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(manage)):
    c = await db.get(K8sCluster, cluster_id)
    if not c:
        raise HTTPException(status_code=404, detail="Cluster not found")
    await db.delete(c)
    await _audit(db, user, request, "k8s.cluster.delete", c.name)


@router.post("/k8s/clusters/{cluster_id}/check")
async def check_cluster(cluster_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(manage)):
    c = await db.get(K8sCluster, cluster_id)
    if not c:
        raise HTTPException(status_code=404, detail="Cluster not found")
    c.last_check_at = datetime.now(timezone.utc)
    try:
        c.version = await k8s.version(c)
        nss = await k8s.namespaces(c)
        c.last_check_status, c.last_check_message = "ok", f"{len(nss)} espace(s) de noms visibles"
    except k8s.K8sError as e:
        c.last_check_status, c.last_check_message = "error", str(e)[:500]
    await db.commit()
    return _cluster_read(c)


# ── policies (management) ──

class PolicyIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=500)
    is_active: bool = True
    valid_from: datetime | None = None
    valid_until: datetime | None = None
    user_ids: list[uuid.UUID] = Field(default_factory=list)
    group_ids: list[uuid.UUID] = Field(default_factory=list)
    cluster_ids: list[uuid.UUID] = Field(min_length=1)
    namespaces: list[str] = Field(default_factory=lambda: ["*"], min_length=1)
    actions: list[str] = Field(default_factory=lambda: ["view", "logs"], min_length=1)

    @field_validator("actions")
    @classmethod
    def _actions(cls, v):
        bad = [a for a in v if a not in K8S_ACTIONS]
        if bad:
            raise ValueError(f"Unknown actions {bad}; allowed {list(K8S_ACTIONS)}")
        return sorted(set(v))

    @field_validator("namespaces")
    @classmethod
    def _ns(cls, v):
        for n in v:
            if n != "*" and not re.match(r"^[a-z0-9*?]([-a-z0-9*?]{0,62})$", n):
                raise ValueError(f"Invalid namespace pattern {n}")
        return v


def _policy_read(p: K8sPolicy) -> dict:
    return {"id": str(p.id), "name": p.name, "description": p.description, "is_active": p.is_active,
            "valid_from": p.valid_from, "valid_until": p.valid_until, "user_ids": p.user_ids or [],
            "group_ids": p.group_ids or [], "cluster_ids": p.cluster_ids or [], "namespaces": p.namespaces or [],
            "actions": p.actions or [], "created_at": p.created_at}


def _apply(p: K8sPolicy, data: PolicyIn) -> None:
    if data.valid_from and data.valid_until and data.valid_until <= data.valid_from:
        raise HTTPException(status_code=400, detail="valid_until must be after valid_from")
    p.name, p.description, p.is_active = data.name, data.description, data.is_active
    p.valid_from, p.valid_until = data.valid_from, data.valid_until
    p.user_ids = [str(x) for x in data.user_ids]
    p.group_ids = [str(x) for x in data.group_ids]
    p.cluster_ids = [str(x) for x in data.cluster_ids]
    p.namespaces, p.actions = data.namespaces, data.actions


@router.get("/k8s/policies")
async def list_policies(db: AsyncSession = Depends(get_db), _: User = Depends(manage)):
    return [_policy_read(p) for p in (await db.execute(select(K8sPolicy).order_by(K8sPolicy.name))).scalars().all()]


@router.post("/k8s/policies", status_code=201)
async def create_policy(data: PolicyIn, request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(manage)):
    if (await db.execute(select(K8sPolicy.id).where(K8sPolicy.name == data.name))).first():
        raise HTTPException(status_code=409, detail="A policy with this name already exists")
    p = K8sPolicy(created_by=user.id)
    _apply(p, data)
    db.add(p)
    await _audit(db, user, request, "k8s.policy.create", f"{p.name}: {p.actions} {p.namespaces}")
    return _policy_read(p)


@router.put("/k8s/policies/{policy_id}")
async def update_policy(policy_id: uuid.UUID, data: PolicyIn, request: Request, db: AsyncSession = Depends(get_db),
                        user: User = Depends(manage)):
    p = await db.get(K8sPolicy, policy_id)
    if not p:
        raise HTTPException(status_code=404, detail="Policy not found")
    _apply(p, data)
    await _audit(db, user, request, "k8s.policy.update", f"{p.name}: {p.actions} {p.namespaces}")
    return _policy_read(p)


@router.delete("/k8s/policies/{policy_id}", status_code=204)
async def delete_policy(policy_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(manage)):
    p = await db.get(K8sPolicy, policy_id)
    if not p:
        raise HTTPException(status_code=404, detail="Policy not found")
    await db.delete(p)
    await _audit(db, user, request, "k8s.policy.delete", p.name)


# ── browsing (users) ──

@router.get("/k8s/clusters/{cluster_id}/namespaces")
async def list_namespaces(cluster_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    cluster, grant = await k8s_access.require_cluster(db, user, cluster_id, "view")
    try:
        items = await k8s.namespaces(cluster)
    except k8s.K8sError as e:
        _err(e)
    return [n for n in items if k8s.ns_allowed(grant.namespaces, n["name"])]


@router.get("/k8s/clusters/{cluster_id}/namespaces/{ns}/pods")
async def list_pods(cluster_id: uuid.UUID, ns: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    cluster, _ = await k8s_access.require_cluster(db, user, cluster_id, "view", _name(ns, "namespace"))
    try:
        return await k8s.pods(cluster, ns)
    except k8s.K8sError as e:
        _err(e)


@router.get("/k8s/clusters/{cluster_id}/namespaces/{ns}/workloads")
async def list_workloads(cluster_id: uuid.UUID, ns: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    cluster, _ = await k8s_access.require_cluster(db, user, cluster_id, "view", _name(ns, "namespace"))
    try:
        return await k8s.workloads(cluster, ns)
    except k8s.K8sError as e:
        _err(e)


@router.get("/k8s/clusters/{cluster_id}/namespaces/{ns}/events")
async def list_events(cluster_id: uuid.UUID, ns: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    cluster, _ = await k8s_access.require_cluster(db, user, cluster_id, "view", _name(ns, "namespace"))
    try:
        return await k8s.events(cluster, ns)
    except k8s.K8sError as e:
        _err(e)


@router.get("/k8s/clusters/{cluster_id}/namespaces/{ns}/pods/{pod}/logs")
async def pod_logs(cluster_id: uuid.UUID, ns: str, pod: str, request: Request,
                   container: str | None = None, tail: int = Query(default=500, ge=1, le=10000), previous: bool = False,
                   db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    cluster, _ = await k8s_access.require_cluster(db, user, cluster_id, "logs", _name(ns, "namespace"))
    _name(pod, "pod")
    if container:
        _name(container, "conteneur")
    try:
        text = await k8s.logs(cluster, ns, pod, container, tail, previous)
    except k8s.K8sError as e:
        _err(e)
    from app.services import masking
    text = (await masking.load(db)).apply(text.encode()).decode(errors="replace")
    await _audit(db, user, request, "k8s.logs", f"{cluster.name}/{ns}/{pod}" + (f"/{container}" if container else ""))
    return {"logs": text}


# ── actions (manage) ──

@router.post("/k8s/clusters/{cluster_id}/namespaces/{ns}/pods/{pod}/delete")
async def delete_pod(cluster_id: uuid.UUID, ns: str, pod: str, request: Request,
                     db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    cluster, _ = await k8s_access.require_cluster(db, user, cluster_id, "manage", _name(ns, "namespace"))
    try:
        await k8s.delete_pod(cluster, ns, _name(pod, "pod"))
    except k8s.K8sError as e:
        await _audit(db, user, request, "k8s.pod.delete", f"{cluster.name}/{ns}/{pod}: {e}", "failure")
        _err(e)
    await _audit(db, user, request, "k8s.pod.delete", f"{cluster.name}/{ns}/{pod}")
    return {"deleted": True}


class ScaleIn(BaseModel):
    replicas: int = Field(ge=0, le=500)


@router.post("/k8s/clusters/{cluster_id}/namespaces/{ns}/workloads/{kind}/{name}/scale")
async def scale_workload(cluster_id: uuid.UUID, ns: str, kind: str, name: str, data: ScaleIn, request: Request,
                         db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    cluster, _ = await k8s_access.require_cluster(db, user, cluster_id, "manage", _name(ns, "namespace"))
    try:
        await k8s.scale(cluster, ns, kind, _name(name, "charge"), data.replicas)
    except k8s.K8sError as e:
        await _audit(db, user, request, "k8s.scale", f"{cluster.name}/{ns}/{kind}/{name} -> {data.replicas}: {e}", "failure")
        _err(e)
    await _audit(db, user, request, "k8s.scale", f"{cluster.name}/{ns}/{kind}/{name} -> {data.replicas}")
    return {"replicas": data.replicas}


@router.post("/k8s/clusters/{cluster_id}/namespaces/{ns}/workloads/{kind}/{name}/restart")
async def restart_workload(cluster_id: uuid.UUID, ns: str, kind: str, name: str, request: Request,
                           db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    cluster, _ = await k8s_access.require_cluster(db, user, cluster_id, "manage", _name(ns, "namespace"))
    try:
        await k8s.rollout_restart(cluster, ns, kind, _name(name, "charge"))
    except k8s.K8sError as e:
        await _audit(db, user, request, "k8s.restart", f"{cluster.name}/{ns}/{kind}/{name}: {e}", "failure")
        _err(e)
    await _audit(db, user, request, "k8s.restart", f"{cluster.name}/{ns}/{kind}/{name}")
    return {"restarted": True}
