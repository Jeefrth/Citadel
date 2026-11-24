"""Live session monitoring for admins (D4).

- /ws/monitor/{session_id}: SSH sessions. Auth message first (like the terminal),
  replays the buffered output, then streams new output. Read-only.
- /ws/monitor-rdp/{session_id}?ticket=: RDP sessions, joins the guacd connection
  with read-only=true (guacd connection sharing). Ticket from
  POST /api/live-sessions/{id}/monitor-ticket.
"""

import asyncio
import json
import logging
import socket
from urllib.parse import parse_qs

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.auth import _get_or_create_dev_user, authenticate_token, enforce_login_acl
from app.core.config import settings
from app.core.database import async_session
from app.core.governance import client_ip
from app.models.audit import AuditLog
from app.models.base import UserRole
from app.models.user import User
from app.services import live, tickets
from app.services.settings_service import get_setting_bool
from app.websocket.rdp import _connect_guacd

router = APIRouter()
logger = logging.getLogger("citadel.monitor")


async def _audit_watch(db, user: User, meta: dict, ip: str | None) -> None:
    db.add(AuditLog(user_id=user.id, server_id=meta.get("server_id"), action="session.monitor", ip_address=ip,
                    result=f"{meta.get('session_id')} user={meta.get('user')} account={meta.get('account')}"))
    await db.commit()


@router.websocket("/ws/monitor/{session_id}")
async def monitor_ssh(websocket: WebSocket, session_id: str):
    await websocket.accept()
    try:
        msg = json.loads(await asyncio.wait_for(websocket.receive_text(), timeout=30))
    except Exception:  # noqa: BLE001
        await websocket.close()
        return
    ip = client_ip(websocket.client.host if websocket.client else None, websocket.headers)
    async with async_session() as db:
        try:
            user = await _get_or_create_dev_user(db) if settings.DEV_MODE else await authenticate_token(msg.get("token", ""), db)
            await enforce_login_acl(db, user, ip)
        except Exception as e:  # noqa: BLE001
            await websocket.send_json({"type": "error", "message": f"Auth failed: {getattr(e, 'detail', e)}"})
            await websocket.close()
            return
        if user.role != UserRole.ADMIN or not user.is_active:
            await websocket.send_json({"type": "error", "message": "Admins only"})
            await websocket.close()
            return
        meta = await live.get(session_id)
        if not meta or meta.get("protocol") != "ssh":
            await websocket.send_json({"type": "error", "message": "Session not found or not an SSH session"})
            await websocket.close()
            return
        await _audit_watch(db, user, meta, ip)
        notify_user = await get_setting_bool(db, "notify_user_on_monitor")
        watcher = user.display_name

    await live.add_watcher(session_id, watcher)
    if notify_user:
        await live.send_control(session_id, {"action": "watch", "by": watcher})
    await websocket.send_json({"type": "meta", "session": meta})
    for chunk in await live.buffered_output(session_id):
        await websocket.send_json({"type": "output", "data": chunk})

    pubsub = live.redis().pubsub()
    await pubsub.subscribe(live.channel("out", session_id))
    stop = asyncio.Event()

    async def _stream():
        idle = 0.0
        while not stop.is_set():
            m = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if m:
                idle = 0.0
                await websocket.send_json({"type": "output", "data": m["data"].decode()})
                continue
            idle += 1.0
            if idle >= 5:  # every few quiet seconds: has the session ended?
                idle = 0.0
                if await live.get(session_id) is None:
                    await websocket.send_json({"type": "ended"})
                    stop.set()

    async def _client():
        try:
            while not stop.is_set():
                await websocket.receive_text()  # read-only: input is ignored
        except (WebSocketDisconnect, Exception):
            stop.set()

    tasks = [asyncio.create_task(_stream()), asyncio.create_task(_client())]
    try:
        await stop.wait()
    finally:
        for t in tasks:
            t.cancel()
        await pubsub.aclose()
        await live.remove_watcher(session_id, watcher)
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass


@router.websocket("/ws/monitor-rdp/{session_id}")
async def monitor_rdp(websocket: WebSocket, session_id: str):
    subprotocols = websocket.scope.get("subprotocols", [])
    await websocket.accept(subprotocol="guacamole" if "guacamole" in subprotocols else None)
    params = parse_qs(websocket.scope.get("query_string", b"").decode())
    payload = await tickets.consume_raw(params.get("ticket", [""])[0])
    if not payload or payload.get("kind") != "monitor-rdp" or payload.get("session_id") != session_id:
        await websocket.close(code=4001, reason="Invalid or expired ticket")
        return
    meta = await live.get(session_id)
    if not meta or not meta.get("guac_connection_id"):
        await websocket.close(code=4004, reason="Session not found")
        return
    width = int(params.get("width", [meta.get("width", 1024)])[0])
    height = int(params.get("height", [meta.get("height", 768)])[0])
    try:
        sock, _ = await asyncio.get_running_loop().run_in_executor(
            None, lambda: _connect_guacd("", 0, "", "", width, height,
                                         join_connection=meta["guac_connection_id"], read_only=True))
    except Exception as e:  # noqa: BLE001
        await websocket.close(code=4005, reason=f"Join failed: {e}"[:120])
        return

    watcher = payload.get("watcher", "admin")
    await live.add_watcher(session_id, watcher)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()

    async def _guacd_to_ws():
        buf = b""
        try:
            while not stop.is_set():
                try:
                    data = await loop.run_in_executor(None, lambda: sock.recv(65536))
                except socket.timeout:
                    await asyncio.sleep(0.005)
                    continue
                if not data:
                    break
                buf += data
                cut = buf.rfind(b";")
                if cut >= 0:
                    await websocket.send_text(buf[:cut + 1].decode("utf-8", errors="replace"))
                    buf = buf[cut + 1:]
        except Exception:  # noqa: BLE001
            pass
        finally:
            stop.set()

    async def _ws_to_guacd():
        try:
            while not stop.is_set():
                data = await websocket.receive_text()
                # read-only is enforced by guacd; sync/size messages still flow
                await loop.run_in_executor(None, lambda d=data: sock.sendall(d.encode("utf-8")))
        except (WebSocketDisconnect, Exception):
            pass
        finally:
            stop.set()

    tasks = [asyncio.create_task(_guacd_to_ws()), asyncio.create_task(_ws_to_guacd())]
    try:
        await stop.wait()
    finally:
        for t in tasks:
            t.cancel()
        try:
            sock.close()
        except Exception:  # noqa: BLE001
            pass
        await live.remove_watcher(session_id, watcher)
