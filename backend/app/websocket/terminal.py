"""Web terminal: WebSocket transport around services.terminal_core."""

import asyncio
import base64
import json
import logging

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from app.core.auth import _get_or_create_dev_user, authenticate_token, enforce_login_acl
from app.core.config import settings
from app.core.database import async_session
from app.core.governance import client_ip
from app.core.permissions import require_server, resolve_for_user
from app.models.base import OSType
from app.models.pam import PolicyAction
from app.services.enforcement import GovernanceDenied, enforce_connect
from app.services.terminal_core import SessionOpenError, SessionSpec, run_session

router = APIRouter()
logger = logging.getLogger("citadel.terminal")


class WebSocketFrontend:
    def __init__(self, ws: WebSocket):
        self.ws = ws

    async def send_output(self, data: bytes) -> None:
        await self.ws.send_json({"type": "output", "data": base64.b64encode(data).decode("ascii")})

    async def notice(self, text: str) -> None:
        await self.ws.send_json({"type": "error", "message": text})

    async def connected(self, session_id: str) -> None:
        await self.ws.send_json({"type": "connected", "session_id": session_id})

    async def disconnected(self) -> None:
        await self.ws.send_json({"type": "disconnected"})

    async def receive(self):
        while True:
            try:
                msg = json.loads(await self.ws.receive_text())
            except (WebSocketDisconnect, Exception):  # noqa: BLE001
                return None
            if msg.get("type") == "input":
                return ("input", base64.b64decode(msg.get("data", "")))
            if msg.get("type") == "resize":
                return ("resize", int(msg.get("cols", 80)), int(msg.get("rows", 24)))


async def _fail(ws: WebSocket, message: str) -> None:
    try:
        await ws.send_json({"type": "error", "message": message})
        await ws.close()
    except Exception:  # noqa: BLE001
        pass


@router.websocket("/ws/terminal/{server_id}")
async def terminal_websocket(websocket: WebSocket, server_id: str):
    """Interactive terminal via WebSocket with session recording.

    Protocol:
    - Client sends JSON: {"type": "auth", "token": "..."} first
    - Client sends JSON: {"type": "input", "data": "..."} for keystrokes
    - Client sends JSON: {"type": "resize", "cols": N, "rows": N}
    - Server sends JSON: {"type": "output", "data": "..."} for terminal output
    - Server sends JSON: {"type": "error", "message": "..."}
    - Server sends JSON: {"type": "connected", "session_id": "..."}
    - Server sends JSON: {"type": "disconnected"}
    """
    await websocket.accept()
    try:
        msg = json.loads(await asyncio.wait_for(websocket.receive_text(), timeout=30))
    except Exception:  # noqa: BLE001
        return await _fail(websocket, "Authentication timeout")
    if msg.get("type") != "auth":
        return await _fail(websocket, "First message must be auth")

    async with async_session() as db:
        if settings.DEV_MODE:
            user = await _get_or_create_dev_user(db)
        else:
            token = msg.get("token")
            if not token:
                return await _fail(websocket, "No token provided")
            # Per-session MFA is enforced by an Entra ID Conditional Access policy
            try:
                user = await authenticate_token(token, db)
                if not user.is_active:
                    raise ValueError("User account is deactivated")
            except Exception as e:  # noqa: BLE001
                return await _fail(websocket, f"Auth failed: {e}")

        # Access policy, account resolution
        try:
            server, grant = await require_server(db, user, server_id, PolicyAction.CONNECT.value)
            account = resolve_for_user(
                server, grant, user,
                account_id=msg.get("account_id"), virtual=msg.get("virtual_account"),
                input_username=msg.get("input_username"), input_password=msg.get("input_password"),
            )
        except HTTPException as e:
            return await _fail(websocket, e.detail)

        # Connection ACL (source IP, hours, review)
        ip = client_ip(websocket.client.host if websocket.client else None, websocket.headers)
        try:
            await enforce_login_acl(db, user, ip)
            await enforce_connect(db, user, server, account.username, ip)
        except HTTPException as e:
            return await _fail(websocket, e.detail)
        except GovernanceDenied as e:
            return await _fail(websocket, e.message)

        if server.os_type != OSType.LINUX:
            return await _fail(websocket, "Interactive terminal not supported for Windows. Use RDP or execute command.")

    spec = SessionSpec(user=user, server=server, account=account, ip=ip,
                       cols=msg.get("cols", 80), rows=msg.get("rows", 24),
                       cert_minutes=msg.get("cert_duration"), channel="web")
    try:
        await run_session(spec, WebSocketFrontend(websocket))
    except SessionOpenError as e:
        return await _fail(websocket, str(e))
    try:
        await websocket.close()
    except Exception:  # noqa: BLE001
        pass
