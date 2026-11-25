"""RDP gateway via Guacamole protocol.

The WebSocket speaks pure Guacamole protocol (no JSON wrapper).
Auth token is passed as a query parameter.
guacd handles the actual RDP connection.
"""

import asyncio
import json
import os
import re
import time
from contextlib import AsyncExitStack
from datetime import datetime, timezone
import uuid
import socket
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.core.database import async_session
from app.core.security import decrypt_value
from app.models.server import Server
from app.core.config import settings
from app.models.session_recording import SessionRecording
from app.models.user import User
from app.services import live, recording_storage, routing
from app.services.tickets import consume_ticket
from app.models.audit import AuditLog

router = APIRouter()
logger = logging.getLogger("citadel.rdp")

GUACD_HOST = os.environ.get("GUACD_HOST", "localhost")
GUACD_PORT = int(os.environ.get("GUACD_PORT", "4822"))
GUACD_RECORDING_PATH = settings.GUACD_RECORDING_PATH


def _guac_encode(*args: str) -> bytes:
    parts = []
    for arg in args:
        parts.append(f"{len(arg)}.{arg}")
    return (",".join(parts) + ";").encode("utf-8")


def _guac_decode(data: bytes) -> list[list[str]]:
    """Decode one or more Guacamole instructions from raw bytes."""
    text = data.decode("utf-8", errors="replace")
    instructions = []
    for instr in text.split(";"):
        instr = instr.strip()
        if not instr:
            continue
        parts = []
        while instr:
            dot = instr.find(".")
            if dot < 0:
                break
            length = int(instr[:dot])
            value = instr[dot + 1: dot + 1 + length]
            parts.append(value)
            instr = instr[dot + 1 + length:]
            if instr.startswith(","):
                instr = instr[1:]
        if parts:
            instructions.append(parts)
    return instructions


READY_RE = re.compile(rb"5\.ready,(\d+)\.")


def _connect_guacd(hostname: str, port: int, username: str, password: str,
                   width: int, height: int, dpi: int = 96,
                   disable_copy: bool = False, disable_paste: bool = False,
                   recording_name: str | None = None,
                   join_connection: str | None = None, read_only: bool = False) -> tuple[socket.socket, str | None]:
    """Connect to guacd and perform the Guacamole handshake.

    New RDP connection, or (join_connection) join an existing one, e.g. read-only
    for live monitoring. Returns (socket, guacd connection id).
    """
    # Split DOMAIN\user format into separate fields
    domain = ""
    if "\\" in username:
        domain, username = username.split("\\", 1)

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.connect((GUACD_HOST, GUACD_PORT))
    sock.settimeout(10)

    # Step 1: Select RDP protocol, or the existing connection to join
    sock.sendall(_guac_encode("select", join_connection or "rdp"))

    # Step 2: Read args instruction
    buf = b""
    while b";" not in buf:
        buf += sock.recv(4096)

    instructions = _guac_decode(buf)
    if not instructions or instructions[0][0] != "args":
        raise RuntimeError(f"Unexpected guacd response: {instructions}")

    arg_names = instructions[0][1:]

    # Step 3: Build connection parameters
    params = {
        "VERSION_1_5_0": "VERSION_1_5_0",
        "hostname": hostname,
        "port": str(port),
        "domain": domain,
        "username": username,
        "password": password,
        "width": str(width),
        "height": str(height),
        "dpi": str(dpi),
        "security": "any",
        "ignore-cert": "true",
        "resize-method": "reconnect",
        "disable-audio": "true",
        "enable-wallpaper": "false",
        "enable-theming": "false",
        "enable-font-smoothing": "true",
        "disable-copy": "true" if disable_copy else "false",
        "disable-paste": "true" if disable_paste else "false",
        "read-only": "true" if read_only else "",
    }
    if recording_name and not join_connection:
        # Native guacd recording (D2). Keystrokes are NOT recorded (passwords).
        params.update({
            "recording-path": GUACD_RECORDING_PATH,
            "recording-name": recording_name,
            "create-recording-path": "true",
            "recording-include-keys": "false",
        })

    # Step 4: Send size, audio, video, image, then connect
    sock.sendall(_guac_encode("size", str(width), str(height), str(dpi)))
    sock.sendall(_guac_encode("audio"))
    sock.sendall(_guac_encode("video"))
    sock.sendall(_guac_encode("image", "image/png", "image/jpeg", "image/webp"))

    arg_values = [params.get(name, "") for name in arg_names]
    sock.sendall(_guac_encode("connect", *arg_values))

    # Wait for ready
    sock.settimeout(5)
    ready_buf = b""
    while b"ready" not in ready_buf and b"error" not in ready_buf:
        ready_buf += sock.recv(4096)

    logger.info("guacd handshake response: %s", ready_buf.decode()[:200])
    if b"error" in ready_buf and b"ready" not in ready_buf:
        error_msg = ready_buf.decode("utf-8", errors="replace")
        raise RuntimeError(f"guacd error: {error_msg}")

    conn_id = None
    m = READY_RE.search(ready_buf)
    if m:
        length = int(m.group(1))
        start = m.end()
        conn_id = ready_buf[start:start + length].decode("utf-8", errors="replace")

    sock.settimeout(0.02)  # Non-blocking reads
    return sock, conn_id


@router.websocket("/ws/rdp/{server_id}")
async def rdp_websocket(websocket: WebSocket, server_id: str):
    """RDP session via pure Guacamole protocol over WebSocket.

    Auth via a one-time ticket: ?ticket=xxx&width=1024&height=768
    After connection, raw Guacamole protocol is exchanged.
    """
    # Accept with guacamole subprotocol if requested
    subprotocols = websocket.scope.get("subprotocols", [])
    if "guacamole" in subprotocols:
        await websocket.accept(subprotocol="guacamole")
    else:
        await websocket.accept()

    # Parse query params manually (avoid FastAPI Query() which can reject before accept)
    query_string = websocket.scope.get("query_string", b"").decode().rstrip("?")
    from urllib.parse import parse_qs
    params = parse_qs(query_string)
    ticket = params.get("ticket", [""])[0]
    width = int(params.get("width", ["1024"])[0])
    height = int(params.get("height", ["768"])[0])

    # Authenticate with a one-time ticket issued by POST /api/servers/{id}/connect-ticket.
    # Policy check and account resolution already happened at issuance.
    consumed = await consume_ticket(ticket)
    if consumed is None:
        await websocket.close(code=4001, reason="Invalid or expired ticket")
        return
    payload, account = consumed
    if payload["protocol"] != "rdp" or payload["server_id"] != str(server_id):
        await websocket.close(code=4003, reason="Ticket not valid for this connection")
        return

    async with async_session() as db:
        from app.core.auth import bind_request
        user = await db.get(User, uuid.UUID(payload["user_id"]))
        if user is None or not payload.get("org_id"):
            await websocket.close(code=4003, reason="Forbidden")
            return
        try:   # the organisation the ticket was issued in
            await bind_request(db, user, org_id=payload["org_id"])
        except Exception:  # noqa: BLE001
            await websocket.close(code=4003, reason="Forbidden")
            return
        server = (await db.execute(select(Server).where(Server.id == uuid.UUID(server_id)))).scalar_one_or_none()
        if user is None or not user.is_active or server is None:
            await websocket.close(code=4003, reason="Forbidden")
            return

        if account.use_cert or not account.password:
            await websocket.close(code=4003, reason="RDP requires a password account")
            return

        rdp_host = server.ip_address
        rdp_port = server.rdp_port or 3389
        rdp_user = account.username
        rdp_pass = decrypt_value(account.password)
        # Clipboard ACL: driven by policy actions captured in the ticket
        disable_copy = not payload["extra"].get("copy", False)
        disable_paste = not payload["extra"].get("paste", False)

        user_id = user.id
        srv_id = server.id
        user_name, server_name = user.display_name, server.name
        sid = f"rdp-{uuid.uuid4()}"
        ip = payload["extra"].get("ip")

        db.add(AuditLog(user_id=user_id, server_id=srv_id, action="rdp.open", result=f"account={account.label}"))
        db.add(SessionRecording(session_id=sid, server_id=srv_id, user_id=user_id, server_name=server_name,
                                user_name=user_name, protocol="rdp", account=account.label,
                                client_ip=ip, events=None))
        await db.commit()

    # Through the zone's gateway if any: local forward reachable by the guacd container
    route_stack = AsyncExitStack()
    try:
        await route_stack.enter_async_context(routing.via(server))
        rdp_host, rdp_port = await routing.tcp_endpoint(rdp_host, rdp_port, for_other_container=True)
    except Exception as e:
        await route_stack.aclose()
        await websocket.close(code=4005, reason=f"Gateway unreachable: {e}"[:120])
        return

    # Connect to guacd
    try:
        sock = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: _connect_guacd(rdp_host, rdp_port, rdp_user, rdp_pass, width, height,
                                   disable_copy=disable_copy, disable_paste=disable_paste,
                                   recording_name=sid),
        )
        sock, guac_conn_id = sock
    except Exception as e:
        logger.error("guacd connection failed: %s", e)
        await route_stack.aclose()
        await websocket.close(code=4005, reason=f"RDP connection failed: {e}")
        return

    logger.info("RDP connected to %s:%d for user %s", rdp_host, rdp_port, rdp_user)
    started = time.time()
    terminated: dict = {}
    try:
        await live.register(sid, {
            "protocol": "rdp", "user_id": str(user_id), "user": user_name, "server_id": str(srv_id),
            "server": server_name, "account": account.label, "client_ip": ip,
            "guac_connection_id": guac_conn_id, "width": width, "height": height,
        })
    except Exception:  # noqa: BLE001
        logger.warning("live registry unavailable for %s", sid)

    sock.settimeout(0.02)

    # Bidirectional proxy: WebSocket <-> guacd socket
    stop = asyncio.Event()

    async def _guacd_to_ws():
        buf = b""
        try:
            while not stop.is_set():
                try:
                    data = await asyncio.get_event_loop().run_in_executor(
                        None, lambda: sock.recv(65536)
                    )
                except socket.timeout:
                    # Flush any complete instructions in buffer
                    if buf:
                        last_semi = buf.rfind(b";")
                        if last_semi >= 0:
                            to_send = buf[:last_semi + 1]
                            buf = buf[last_semi + 1:]
                            await websocket.send_text(to_send.decode("utf-8", errors="replace"))
                    await asyncio.sleep(0.005)
                    continue
                except Exception:
                    break

                if not data:
                    break

                buf += data
                # Send only complete instructions (up to last ';')
                last_semi = buf.rfind(b";")
                if last_semi >= 0:
                    to_send = buf[:last_semi + 1]
                    buf = buf[last_semi + 1:]
                    await websocket.send_text(to_send.decode("utf-8", errors="replace"))
        except Exception:
            pass
        finally:
            stop.set()

    async def _ws_to_guacd():
        try:
            while not stop.is_set():
                data = await websocket.receive_text()
                await asyncio.get_event_loop().run_in_executor(
                    None, lambda d=data: sock.sendall(d.encode("utf-8"))
                )
        except (WebSocketDisconnect, Exception):
            pass
        finally:
            stop.set()

    async def _control():
        pubsub = live.redis().pubsub()
        try:
            await pubsub.subscribe(live.channel("ctl", sid))
            last_beat = 0.0
            while not stop.is_set():
                msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if time.time() - last_beat > 20:
                    last_beat = time.time()
                    await live.heartbeat(sid)
                if not msg:
                    continue
                ctl = json.loads(msg["data"])
                if ctl.get("action") == "kill":
                    terminated.update(by=ctl.get("by"), reason=ctl.get("reason"))
                    stop.set()
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001
            logger.warning("control channel unavailable for %s", sid)
        finally:
            try:
                await pubsub.aclose()
            except Exception:  # noqa: BLE001
                pass

    tasks = [
        asyncio.create_task(_guacd_to_ws()),
        asyncio.create_task(_ws_to_guacd()),
        asyncio.create_task(_control()),
    ]

    try:
        await stop.wait()
        await asyncio.sleep(0.5)
    finally:
        for t in tasks:
            t.cancel()
        try:
            sock.close()
        except Exception:
            pass

        if terminated:
            try:
                await websocket.close(code=4010, reason=f"Session terminée par {terminated.get('by')}"[:120])
            except Exception:  # noqa: BLE001
                pass
        try:
            await live.unregister(sid)
        except Exception:  # noqa: BLE001
            pass
        await route_stack.aclose()
        await _store_rdp_recording(sid, user_id, srv_id, started, terminated)


async def _store_rdp_recording(sid: str, user_id, srv_id, started: float, terminated: dict) -> None:
    """Move the raw guacd dump to the recording storage (gzip + SHA-256), close the audit trail."""
    raw_path = os.path.join(GUACD_RECORDING_PATH, sid)
    await asyncio.sleep(1)  # let guacd flush and close the file
    try:
        async with async_session() as db:
            rec = (await db.execute(select(SessionRecording).where(SessionRecording.session_id == sid))).scalar_one_or_none()
            duration = int(time.time() - started)
            note = f"{duration}s"
            if os.path.exists(raw_path):
                with open(raw_path, "rb") as f:
                    raw = f.read()
                key = f"rdp/{datetime.now(timezone.utc):%Y/%m/%d}/{sid}.guac.gz"
                stored = await recording_storage.store(db, key, raw)
                os.unlink(raw_path)
                if rec:
                    rec.storage_type, rec.storage_key, rec.sha256 = stored.storage_type, stored.key, stored.sha256
                    rec.size_bytes = len(raw)
                note += f", {len(raw)} bytes recorded"
            else:
                logger.warning("no guacd recording found at %s", raw_path)
                note += ", no recording file"
            if rec:
                rec.ended_at = datetime.now(timezone.utc)
                rec.duration_seconds = duration
                rec.terminated_by = terminated.get("by")
                rec.termination_reason = terminated.get("reason")
            db.add(AuditLog(user_id=user_id, server_id=srv_id, action="rdp.close",
                            result=note + (f", killed by {terminated['by']}" if terminated.get("by") else "")))
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.exception("failed to store RDP recording %s", sid)
