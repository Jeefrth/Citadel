"""RDP gateway via Guacamole protocol.

The WebSocket speaks pure Guacamole protocol (no JSON wrapper).
Auth token is passed as a query parameter.
guacd handles the actual RDP connection.
"""

import asyncio
import socket
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.core.auth import _validate_token, _sync_user, _get_or_create_dev_user
from app.core.config import settings
from app.core.database import async_session
from app.core.security import decrypt_value
from app.models.server import Server
from app.models.credential import Credential
from app.models.audit import AuditLog

router = APIRouter()
logger = logging.getLogger("citadel.rdp")

GUACD_HOST = "localhost"
GUACD_PORT = 4822


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


def _connect_guacd(hostname: str, port: int, username: str, password: str,
                   width: int, height: int, dpi: int = 96) -> socket.socket:
    """Connect to guacd and perform the Guacamole handshake for RDP."""
    # Split DOMAIN\user format into separate fields
    domain = ""
    if "\\" in username:
        domain, username = username.split("\\", 1)

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.connect((GUACD_HOST, GUACD_PORT))
    sock.settimeout(10)

    # Step 1: Select RDP protocol
    sock.sendall(_guac_encode("select", "rdp"))

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
    }

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

    sock.settimeout(0.02)  # Non-blocking reads
    return sock


@router.websocket("/ws/rdp/{server_id}")
async def rdp_websocket(websocket: WebSocket, server_id: str):
    """RDP session via pure Guacamole protocol over WebSocket.

    Auth via query params: ?token=xxx&width=1024&height=768
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
    token = params.get("token", [""])[0]
    width = int(params.get("width", ["1024"])[0])
    height = int(params.get("height", ["768"])[0])

    # Authenticate
    async with async_session() as db:
        if settings.DEV_MODE:
            user = await _get_or_create_dev_user(db)
        else:
            if not token:
                await websocket.close(code=4001, reason="No token")
                return
            try:
                claims = await _validate_token(token)
                user = await _sync_user(claims, db)
            except Exception as e:
                await websocket.close(code=4001, reason=f"Auth failed: {e}")
                return

        # Get server + credentials
        result = await db.execute(select(Server).where(Server.id == server_id))
        server = result.scalar_one_or_none()
        if not server:
            await websocket.close(code=4004, reason="Server not found")
            return

        credential = None
        if server.credential_id:
            cred_result = await db.execute(
                select(Credential).where(Credential.id == server.credential_id)
            )
            credential = cred_result.scalar_one_or_none()

        if not credential or not credential.encrypted_password:
            await websocket.close(code=4003, reason="No RDP credential (password required)")
            return

        rdp_host = server.ip_address
        rdp_port = 3389  # Standard RDP port
        rdp_user = credential.username
        rdp_pass = decrypt_value(credential.encrypted_password)

        user_id = user.id
        srv_id = server.id

        db.add(AuditLog(user_id=user_id, server_id=srv_id, action="rdp.open"))
        await db.commit()

    # Connect to guacd
    try:
        sock = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: _connect_guacd(rdp_host, rdp_port, rdp_user, rdp_pass, width, height),
        )
    except Exception as e:
        logger.error("guacd connection failed: %s", e)
        await websocket.close(code=4005, reason=f"RDP connection failed: {e}")
        return

    logger.info("RDP connected to %s:%d for user %s", rdp_host, rdp_port, rdp_user)

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

    tasks = [
        asyncio.create_task(_guacd_to_ws()),
        asyncio.create_task(_ws_to_guacd()),
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

        async with async_session() as db:
            db.add(AuditLog(user_id=user_id, server_id=srv_id, action="rdp.close"))
            await db.commit()
