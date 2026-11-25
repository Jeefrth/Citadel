"""Shell in a Kubernetes container (lot 8), same pipeline as the SSH terminal:
recording, command ACL per line, masking, live view, admin kill."""

import asyncio
import json

from fastapi import APIRouter, HTTPException, WebSocket

from app.core.auth import authenticate_ws, enforce_login_acl
from app.core.config import settings
from app.core.database import async_session
from app.core.governance import client_ip
from app.services import k8s_session
from app.services.terminal_core import SessionOpenError, run_session
from app.websocket.terminal import WebSocketFrontend, _fail

router = APIRouter()


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
            user = await authenticate_ws(db, msg)
        except Exception as e:  # noqa: BLE001
            return await _fail(websocket, f"Auth failed: {getattr(e, 'detail', e)}")
        ip = client_ip(websocket.client.host if websocket.client else None, websocket.headers)
        try:
            await enforce_login_acl(db, user, ip)
            spec = await k8s_session.prepare(db, user, cluster_id, ns, pod, container, ip,
                                             cols=msg.get("cols", 80), rows=msg.get("rows", 24))
        except HTTPException as e:
            return await _fail(websocket, e.detail)
        except k8s_session.K8sSessionDenied as e:
            return await _fail(websocket, e.message)

    try:
        await run_session(spec, WebSocketFrontend(websocket))
    except SessionOpenError as e:
        return await _fail(websocket, str(e))
    try:
        await websocket.close()
    except Exception:  # noqa: BLE001
        pass
