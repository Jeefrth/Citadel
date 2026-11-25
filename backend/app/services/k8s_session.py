"""Shell in a Kubernetes container, shared by the web terminal (WebSocket) and the
SSH proxy (lot 8): name checks, rights on the namespace, container choice,
connection ACL, then a SessionSpec for services.terminal_core.run_session.
The caller has already authenticated the user and applied the login ACL."""

import re
from dataclasses import dataclass, field

from fastapi import HTTPException

from app.core.permissions import ResolvedAccount
from app.models.user import User
from app.services import k8s, k8s_access
from app.services.enforcement import GovernanceDenied, enforce_connect
from app.services.terminal_core import SessionSpec


class K8sSessionDenied(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


@dataclass
class K8sTarget:
    """Shape expected by the governance engine for a non-server target."""
    id: str
    name: str
    node_id: object = None
    tags: dict = field(default_factory=dict)
    link: str = ""
    is_k8s: bool = True


def valid_name(value: str | None) -> bool:
    return bool(value) and bool(re.match(k8s.NAME, value))


async def prepare(db, user: User, cluster_id, ns: str, pod: str, container: str | None, ip: str | None,
                  cols: int = 80, rows: int = 24, channel: str = "k8s") -> SessionSpec:
    if not valid_name(ns) or not valid_name(pod) or (container and not valid_name(container)):
        raise K8sSessionDenied("Nom d'espace de noms, de pod ou de conteneur invalide")
    try:
        cluster, _ = await k8s_access.require_cluster(db, user, cluster_id, "exec", ns)
        containers = await k8s.pod_containers(cluster, ns, pod)
    except HTTPException as e:
        raise K8sSessionDenied(str(e.detail))
    except k8s.K8sError as e:
        raise K8sSessionDenied(str(e))
    container = container or (containers[0] if containers else None)
    if container not in containers:
        raise K8sSessionDenied("Conteneur introuvable dans ce pod")
    target = K8sTarget(id=str(cluster.id), name=f"{cluster.name}/{ns}/{pod}/{container}", node_id=cluster.node_id,
                       tags={**(cluster.tags or {}), "k8s_cluster": cluster.name, "k8s_namespace": ns},
                       link=f"/kubernetes/{cluster.id}")
    account = ResolvedAccount(username=f"k8s:{ns}", label=f"k8s:{ns}/{pod}/{container}")
    try:
        await enforce_connect(db, user, target, account.username, ip)
    except GovernanceDenied as e:
        raise K8sSessionDenied(e.message)

    async def opener(c, r):
        return await k8s.open_exec(cluster, ns, pod, container, c, r)

    return SessionSpec(user=user, server=target, account=account, ip=ip, cols=cols, rows=rows,
                       channel=channel, protocol="k8s", open_channel=opener, route=cluster)
