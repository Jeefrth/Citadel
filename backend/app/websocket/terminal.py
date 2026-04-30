import asyncio
import base64
import json
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import _validate_token, _sync_user, _get_or_create_dev_user
from app.core.config import settings
from app.core.database import async_session
from app.models.server import Server
from app.models.credential import Credential
from app.models.audit import AuditLog
from app.models.session_recording import SessionRecording
from app.models.base import OSType
from app.websocket.session_manager import session_manager

router = APIRouter()


class SessionRecorder:
    """Records all terminal I/O events with timestamps for replay."""

    def __init__(self):
        self.events: list[dict] = []
        self.start_time: float = time.time()
        self.size_bytes: int = 0

    def record_output(self, data: bytes):
        elapsed_ms = int((time.time() - self.start_time) * 1000)
        encoded = base64.b64encode(data).decode("ascii")
        self.events.append({"t": elapsed_ms, "type": "o", "data": encoded})
        self.size_bytes += len(data)

    def record_input(self, data: bytes):
        elapsed_ms = int((time.time() - self.start_time) * 1000)
        encoded = base64.b64encode(data).decode("ascii")
        self.events.append({"t": elapsed_ms, "type": "i", "data": encoded})
        self.size_bytes += len(data)

    @property
    def duration_seconds(self) -> int:
        return int(time.time() - self.start_time)

    @property
    def event_count(self) -> int:
        return len(self.events)


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

    # Step 1: Authenticate (longer timeout for forceRefresh token acquisition)
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=30)
        msg = json.loads(raw)
    except Exception:
        try:
            await websocket.send_json({"type": "error", "message": "Authentication timeout"})
        except Exception:
            pass
        await websocket.close()
        return

    if msg.get("type") != "auth":
        await websocket.send_json({"type": "error", "message": "First message must be auth"})
        await websocket.close()
        return

    # Authenticate user
    async with async_session() as db:
        if settings.DEV_MODE:
            user = await _get_or_create_dev_user(db)
        else:
            token = msg.get("token")
            if not token:
                await websocket.send_json({"type": "error", "message": "No token provided"})
                await websocket.close()
                return

            # Note: per-session MFA is enforced via Entra ID Conditional Access policy
            # Configure: Entra ID → Security → Conditional Access → require MFA for this app

            try:
                claims = await _validate_token(token)
                user = await _sync_user(claims, db)
            except Exception as e:
                await websocket.send_json({"type": "error", "message": f"Auth failed: {e}"})
                await websocket.close()
                return

        # Step 2: Get server and credential
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

        if not credential and not server.cert_auth_enabled:
            await websocket.send_json({"type": "error", "message": "No credential and cert auth not enabled"})
            await websocket.close()
            return

        # Determine username
        if credential:
            ssh_user = credential.username
        elif server.ssh_username:
            ssh_user = server.ssh_username
        else:
            await websocket.send_json({"type": "error", "message": "No SSH username configured"})
            await websocket.close()
            return

        # Step 3: Open interactive session
        cols = msg.get("cols", 80)
        rows = msg.get("rows", 24)
        # Client can request a specific cert duration (minutes)
        requested_duration = msg.get("cert_duration", None)

        try:
            from app.models.base import CredentialType

            # Determine auth mode
            use_cert = server.cert_auth_enabled and not credential
            if credential and credential.type == CredentialType.EPHEMERAL_CERT:
                use_cert = True

            cert_minutes = requested_duration or (credential.cert_validity_minutes if credential and use_cert else None) or 480

            if server.os_type == OSType.LINUX:
                session = await session_manager.create_ssh_session(
                    server_id=str(server.id),
                    user_id=str(user.id),
                    host=server.ip_address,
                    port=server.ssh_port,
                    username=ssh_user,
                    password=credential.encrypted_password if credential and not use_cert else None,
                    ssh_key=credential.encrypted_ssh_key if credential and not use_cert else None,
                    use_ephemeral_cert=use_cert,
                    cert_validity_minutes=cert_minutes,
                    cols=cols,
                    rows=rows,
                )
            else:
                await websocket.send_json({
                    "type": "error",
                    "message": "Interactive terminal not supported for Windows. Use execute command.",
                })
                await websocket.close()
                return
        except Exception as e:
            await websocket.send_json({"type": "error", "message": f"Connection failed: {e}"})
            await websocket.close()
            return

        # Save references for recording
        server_name = server.name
        user_name = user.display_name
        user_id = user.id
        srv_id = server.id

        # Compute max session duration based on cert validity
        cert_max_seconds = None
        if use_cert:
            cert_max_seconds = cert_minutes * 60

        # Log session start
        db.add(AuditLog(
            user_id=user_id,
            server_id=srv_id,
            action="terminal.open",
            result=f"cert={cert_max_seconds}s" if cert_max_seconds else "password/key",
        ))
        await db.commit()

    # Start recording
    recorder = SessionRecorder()
    stop_event = asyncio.Event()
    last_activity = time.time()
    session_start = time.time()
    IDLE_TIMEOUT = 1800  # 30 minutes

    await websocket.send_json({"type": "connected", "session_id": session.session_id})

    # Session timeout watchdog (idle + cert expiry)
    async def _idle_watchdog():
        nonlocal last_activity
        while not stop_event.is_set():
            await asyncio.sleep(10)

            # Check cert expiry (hard limit)
            if cert_max_seconds:
                elapsed = time.time() - session_start
                remaining = cert_max_seconds - elapsed
                if remaining <= 0:
                    try:
                        await websocket.send_json({
                            "type": "error",
                            "message": f"Certificate expired — session closed after {cert_max_seconds // 60} minutes",
                        })
                    except Exception:
                        pass
                    stop_event.set()
                    break
                # Warn before expiry
                if remaining <= 300 and remaining > 290:
                    try:
                        await websocket.send_json({
                            "type": "error",
                            "message": f"Warning: session expires in 5 minutes",
                        })
                    except Exception:
                        pass
                elif remaining <= 60 and remaining > 50:
                    try:
                        await websocket.send_json({
                            "type": "error",
                            "message": f"Warning: session expires in {int(remaining)} seconds",
                        })
                    except Exception:
                        pass

            # Check idle timeout
            if time.time() - last_activity > IDLE_TIMEOUT:
                try:
                    await websocket.send_json({
                        "type": "error",
                        "message": f"Session expired after {IDLE_TIMEOUT // 60} minutes of inactivity",
                    })
                except Exception:
                    pass
                stop_event.set()
                break

    # Step 4: Bidirectional streaming with recording
    async def _read_from_server():
        try:
            while not stop_event.is_set():
                data = await session_manager.read(session.session_id)
                if data is None:
                    try:
                        await websocket.send_json({"type": "disconnected"})
                    except Exception:
                        pass
                    break
                if data:
                    recorder.record_output(data)
                    try:
                        await websocket.send_json({
                            "type": "output",
                            "data": base64.b64encode(data).decode("ascii"),
                        })
                    except Exception:
                        break
        except Exception:
            pass
        finally:
            stop_event.set()

    async def _read_from_client():
        nonlocal last_activity
        try:
            while not stop_event.is_set():
                raw = await websocket.receive_text()
                msg = json.loads(raw)
                last_activity = time.time()

                if msg["type"] == "input":
                    data = base64.b64decode(msg["data"])
                    recorder.record_input(data)
                    await session_manager.write(session.session_id, data)
                elif msg["type"] == "resize":
                    await session_manager.resize(
                        session.session_id,
                        msg.get("cols", 80),
                        msg.get("rows", 24),
                    )
        except (WebSocketDisconnect, Exception):
            pass
        finally:
            stop_event.set()

    # Run all tasks, cancel survivors when one exits
    tasks = [
        asyncio.create_task(_read_from_server()),
        asyncio.create_task(_read_from_client()),
        asyncio.create_task(_idle_watchdog()),
    ]

    try:
        # Wait for stop signal
        await stop_event.wait()
        # Give tasks a moment to finish
        await asyncio.sleep(0.5)
    finally:
        # Cancel remaining tasks
        for t in tasks:
            t.cancel()

        await session_manager.close(session.session_id)

        # Save recording + audit log
        try:
            async with async_session() as db:
                recording = SessionRecording(
                    session_id=session.session_id,
                    server_id=srv_id,
                    user_id=user_id,
                    server_name=server_name,
                    user_name=user_name,
                    events=recorder.events,
                    duration_seconds=recorder.duration_seconds,
                    event_count=recorder.event_count,
                    size_bytes=recorder.size_bytes,
                )
                db.add(recording)

                db.add(AuditLog(
                    user_id=user_id,
                    server_id=srv_id,
                    action="terminal.close",
                    result=f"Recorded {recorder.event_count} events, {recorder.duration_seconds}s",
                ))
                await db.commit()
        except Exception:
            pass  # Don't crash on recording save failure
