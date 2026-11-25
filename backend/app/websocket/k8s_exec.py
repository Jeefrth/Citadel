"""Shell in a Kubernetes container (lot 8), same pipeline as the SSH terminal:
recording, command ACL per line, masking, live view, admin kill."""

import asyncio
import json
from dataclasses import dataclass, field

from fastapi import APIRouter, HTTPException, WebSocket

from app.core.auth import _get_or_create_dev_user, authenticate_token, enforce_login_acl
from app.core.config import settings
from app.core.database import async_session
from app.core.governance import client_ip
from app.core.permissions import ResolvedAccount
from app.services import k8s, k8s_access
from app.services.enforcement import GovernanceDenied, enforce_connect
from app.services.terminal_core import SessionOpenError, SessionSpec, run_session
from app.websocket.terminal import WebSocketFrontend, _fail

router = APIRouter()


@dataclass
class K8sTarget:
    """Shape expected by the governance engine for a non-server target."""
    id: str
    name: str
    node_id: object = None
    tags: dict = field(default_factory=dict)
    link: str = ""
    is_k8s: bool = True


@router.websocket("/ws/k8s-exec/{cluster_id}")
async def k8s_exec(websocket: WebSocket, cluster_id: str):
    """First message: {"type": "auth", "token", "namespace", "pod", "container", "cols", "rows"}.
    Then the same protocol as /ws/terminal."""
    await websocket.accept()
    try:
        msg = json.loads(await asyncio.wait_for(websocket.receive_text(), timeout=30))
    except Exception:  # noqa: BLE001
        return await _fail(websocket, "Authentication timeout")
    if msg.get("type") != "auth":
        return await _fail(websocket, "First message must be auth")
    ns, pod, container = str(msg.get("namespace", "")), str(msg.get("pod", "")), msg.get("container")

    async with async_session() as db:
        try:
            user = await _get_or_create_dev_user(db) if settings.DEV_MODE else await authenticate_token(msg.get("token", ""), db)
            if not user.is_active:
                raise ValueError("User account is deactivated")
        except Exception as e:  # noqa: BLE001
            return await _fail(websocket, f"Auth failed: {getattr(e, 'detail', e)}")
        try:
            if not k8s.re.match(k8s.NAME, ns) or not k8s.re.match(k8s.NAME, pod) or (container and not k8s.re.match(k8s.NAME, container)):
                raise HTTPException(status_code=400, detail="Invalid namespace, pod or container name")
            cluster, _ = await k8s_access.require_cluster(db, user, cluster_id, "exec", ns)
            containers = await k8s.pod_containers(cluster, ns, pod)
            container = container or (containers[0] if containers else None)
            if container not in containers:
                raise HTTPException(status_code=404, detail="Container not found in this pod")
        except HTTPException as e:
            return await _fail(websocket, e.detail)
        except k8s.K8sError as e:
            return await _fail(websocket, str(e))

        target = K8sTarget(id=str(cluster.id), name=f"{cluster.name}/{ns}/{pod}/{container}", node_id=cluster.node_id,
                           tags={**(cluster.tags or {}), "k8s_cluster": cluster.name, "k8s_namespace": ns},
                           link=f"/kubernetes/{cluster.id}")
        account = ResolvedAccount(username=f"k8s:{ns}", label=f"k8s:{ns}/{pod}/{container}")
        ip = client_ip(websocket.client.host if websocket.client else None, websocket.headers)
        try:
            await enforce_login_acl(db, user, ip)
            await enforce_connect(db, user, target, account.username, ip)
        except HTTPException as e:
            return await _fail(websocket, e.detail)
        except GovernanceDenied as e:
            return await _fail(websocket, e.message)

    async def opener(cols, rows):
        return await k8s.open_exec(cluster, ns, pod, container, cols, rows)

    spec = SessionSpec(user=user, server=target, account=account, ip=ip, cols=msg.get("cols", 80),
                       rows=msg.get("rows", 24), channel="k8s", protocol="k8s", open_channel=opener, route=cluster)
    try:
        await run_session(spec, WebSocketFrontend(websocket))
    except SessionOpenError as e:
        return await _fail(websocket, str(e))
    try:
        await websocket.close()
    except Exception:  # noqa: BLE001
        pass
