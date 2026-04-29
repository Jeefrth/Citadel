import asyncio
import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import _validate_token, _sync_user
from app.core.database import async_session
from app.models.server import Server
from app.models.credential import Credential
from app.models.audit import AuditLog
from app.models.base import OSType
from app.websocket.session_manager import session_manager

router = APIRouter()


async def _authenticate_ws(websocket: WebSocket) -> dict | None:
    """Authenticate WebSocket via token in query param or first message."""
    token = websocket.query_params.get("token")
    if not token:
        # Try to get token from first message
        try:
            first_msg = await asyncio.wait_for(websocket.receive_text(), timeout=5)
            data = json.loads(first_msg)
            token = data.get("token")
        except Exception:
            return None

    if not token:
        return None

    try:
        claims = await _validate_token(token)
        return claims
    except Exception:
        return None


@router.websocket("/ws/terminal/{server_id}")
async def terminal_websocket(websocket: WebSocket, server_id: str):
    """Interactive terminal via WebSocket.

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

    # Step 1: Authenticate
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=10)
        msg = json.loads(raw)
    except Exception:
        await websocket.send_json({"type": "error", "message": "Authentication timeout"})
        await websocket.close()
        return

    if msg.get("type") != "auth" or not msg.get("token"):
        await websocket.send_json({"type": "error", "message": "First message must be auth"})
        await websocket.close()
        return

    try:
        claims = await _validate_token(msg["token"])
    except Exception as e:
        await websocket.send_json({"type": "error", "message": f"Auth failed: {e}"})
        await websocket.close()
        return

    # Step 2: Get user and server info
    async with async_session() as db:
        user = await _sync_user(claims, db)

        result = await db.execute(select(Server).where(Server.id == server_id))
        server = result.scalar_one_or_none()
        if not server:
            await websocket.send_json({"type": "error", "message": "Server not found"})
            await websocket.close()
            return

        credential = None
        if server.credential_id:
            cred_result = await db.execute(
                select(Credential).where(Credential.id == server.credential_id)
            )
            credential = cred_result.scalar_one_or_none()

        if not credential:
            await websocket.send_json({"type": "error", "message": "No credential for this server"})
            await websocket.close()
            return

        # Step 3: Open interactive session
        cols = msg.get("cols", 80)
        rows = msg.get("rows", 24)

        try:
            if server.os_type == OSType.LINUX:
                session = await session_manager.create_ssh_session(
                    server_id=str(server.id),
                    user_id=str(user.id),
                    host=server.ip_address,
                    port=server.ssh_port,
                    username=credential.username,
                    password=credential.encrypted_password,
                    ssh_key=credential.encrypted_ssh_key,
                    cols=cols,
                    rows=rows,
                )
            else:
                await websocket.send_json({
                    "type": "error",
                    "message": "Interactive terminal for Windows is not yet supported. Use the execute command instead.",
                })
                await websocket.close()
                return

        except Exception as e:
            await websocket.send_json({"type": "error", "message": f"Connection failed: {e}"})
            await websocket.close()
            return

        # Log session start
        db.add(AuditLog(
            user_id=user.id,
            server_id=server.id,
            action="terminal.open",
        ))
        await db.commit()

    await websocket.send_json({"type": "connected", "session_id": session.session_id})

    # Step 4: Bidirectional streaming
    async def _read_from_server():
        """Read from SSH and send to WebSocket."""
        try:
            while not session.is_closed:
                data = await session_manager.read(session.session_id)
                if data is None:
                    # EOF — session ended
                    await websocket.send_json({"type": "disconnected"})
                    break
                if data:
                    # Send binary data as base64 to preserve encoding
                    import base64
                    await websocket.send_json({
                        "type": "output",
                        "data": base64.b64encode(data).decode("ascii"),
                    })
        except WebSocketDisconnect:
            pass
        except Exception:
            pass

    async def _read_from_client():
        """Read from WebSocket and send to SSH."""
        try:
            while not session.is_closed:
                raw = await websocket.receive_text()
                msg = json.loads(raw)

                if msg["type"] == "input":
                    import base64
                    data = base64.b64decode(msg["data"])
                    await session_manager.write(session.session_id, data)
                elif msg["type"] == "resize":
                    await session_manager.resize(
                        session.session_id,
                        msg.get("cols", 80),
                        msg.get("rows", 24),
                    )
        except WebSocketDisconnect:
            pass
        except Exception:
            pass

    # Run both tasks concurrently
    try:
        await asyncio.gather(
            _read_from_server(),
            _read_from_client(),
            return_exceptions=True,
        )
    finally:
        await session_manager.close(session.session_id)

        # Log session end
        async with async_session() as db:
            db.add(AuditLog(
                user_id=user.id,
                server_id=server.id,
                action="terminal.close",
            ))
            await db.commit()
