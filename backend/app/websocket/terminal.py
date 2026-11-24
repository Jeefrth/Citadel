import asyncio
import base64
import json
import logging
import time
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from app.core.auth import authenticate_token, _get_or_create_dev_user
from app.core.config import settings
from app.core.database import async_session
from app.core.auth import enforce_login_acl
from app.core.governance import client_ip
from app.core.permissions import require_server, resolve_for_user
from app.models.server import Server
from app.models.user import User
from sqlalchemy import select

from app.services import live, recording_storage
from app.services.command_log import log_command
from app.services.enforcement import GovernanceDenied, check_command, enforce_connect
from app.websocket.line_tracker import KILL_LINE, LineTracker
from app.models.pam import PolicyAction
from app.models.audit import AuditLog
from app.models.session_recording import SessionRecording
from app.models.base import OSType
from app.websocket.session_manager import session_manager

router = APIRouter()
logger = logging.getLogger("citadel.terminal")


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
                user = await authenticate_token(token, db)
                if not user.is_active:
                    raise ValueError("User account is deactivated")
            except Exception as e:
                await websocket.send_json({"type": "error", "message": f"Auth failed: {e}"})
                await websocket.close()
                return

        # Step 2: Authorize (policy) and resolve the connection account
        try:
            server, grant = await require_server(db, user, server_id, PolicyAction.CONNECT.value)
            account = resolve_for_user(
                server, grant, user,
                account_id=msg.get("account_id"),
                virtual=msg.get("virtual_account"),
                input_username=msg.get("input_username"),
                input_password=msg.get("input_password"),
            )
        except HTTPException as e:
            await websocket.send_json({"type": "error", "message": e.detail})
            await websocket.close()
            return

        # Connection ACL (source IP, hours, review)
        ip = client_ip(websocket.client.host if websocket.client else None, websocket.headers)
        try:
            await enforce_login_acl(db, user, ip)
            await enforce_connect(db, user, server, account.username, ip)
        except HTTPException as e:
            await websocket.send_json({"type": "error", "message": e.detail})
            await websocket.close()
            return
        except GovernanceDenied as e:
            await websocket.send_json({"type": "error", "message": e.message})
            await websocket.close()
            return

        if server.os_type != OSType.LINUX:
            await websocket.send_json({
                "type": "error",
                "message": "Interactive terminal not supported for Windows. Use RDP or execute command.",
            })
            await websocket.close()
            return

        # Step 3: Open interactive session
        cols = msg.get("cols", 80)
        rows = msg.get("rows", 24)
        # Client can request a specific cert duration (minutes)
        requested_duration = msg.get("cert_duration", None)
        use_cert = account.use_cert
        cert_minutes = requested_duration or account.cert_minutes or 480

        try:
            session = await session_manager.create_ssh_session(
                server_id=str(server.id),
                user_id=str(user.id),
                host=server.ip_address,
                port=server.ssh_port,
                username=account.username,
                password=account.password,
                ssh_key=account.ssh_key,
                use_ephemeral_cert=use_cert,
                cert_validity_minutes=cert_minutes,
                cols=cols,
                rows=rows,
            )
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
            result=(f"account={account.label} "
                    + (f"cert={cert_max_seconds}s" if cert_max_seconds else "password/key")),
        ))
        # Recording row created at start: an interrupted session still leaves a trace
        db.add(SessionRecording(
            session_id=session.session_id, server_id=srv_id, user_id=user_id,
            server_name=server_name, user_name=user_name, protocol="ssh",
            account=account.label, client_ip=ip, events=None,
        ))
        await db.commit()

    # Start recording
    recorder = SessionRecorder()
    tracker = LineTracker()
    stop_event = asyncio.Event()
    last_activity = time.time()
    session_start = time.time()
    IDLE_TIMEOUT = 1800  # 30 minutes

    await websocket.send_json({"type": "connected", "session_id": session.session_id})
    sid = session.session_id
    terminated: dict = {}
    try:
        await live.register(sid, {
            "protocol": "ssh", "user_id": str(user_id), "user": user_name, "server_id": str(srv_id),
            "server": server_name, "account": account.label, "client_ip": ip,
        })
    except Exception:  # noqa: BLE001 - live monitoring must never block a session
        logger.warning("live registry unavailable for %s", sid)

    # Session timeout watchdog (idle + cert expiry)
    async def _idle_watchdog():
        nonlocal last_activity
        while not stop_event.is_set():
            await asyncio.sleep(10)
            try:
                await live.heartbeat(sid, last_activity=last_activity)
            except Exception:  # noqa: BLE001
                pass

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
                    tracker.on_output(data)
                    b64 = base64.b64encode(data).decode("ascii")
                    try:
                        await live.publish_output(sid, b64)
                    except Exception:  # noqa: BLE001
                        pass
                    try:
                        await websocket.send_json({"type": "output", "data": b64})
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
                    for chunk, enter in tracker.split(data):
                        if chunk:
                            tracker.feed(chunk)
                            await session_manager.write(session.session_id, chunk)
                        if not enter:
                            continue
                        await tracker.settle()
                        command = tracker.take_line()
                        if command:
                            async with async_session() as cdb:
                                cuser = await cdb.get(User, user_id)
                                cserver = await cdb.get(Server, srv_id)
                                outcome = await check_command(
                                    cdb, cuser, cserver, account.username, command, ip, source="terminal")
                                await log_command(
                                    cdb, user=cuser, server=cserver, account=account.label, command=command,
                                    source="terminal", decision=outcome.decision, rule=outcome.rule,
                                    session_id=sid, ip=ip,
                                    offset_ms=int((time.time() - recorder.start_time) * 1000))
                            if not outcome.allowed:
                                # Never send Enter: clear the typed line, get a fresh prompt
                                note = f"\r\n\x1b[1;31m[Citadel] {outcome.message}\x1b[0m\r\n"
                                await websocket.send_json({
                                    "type": "output",
                                    "data": base64.b64encode(note.encode()).decode("ascii"),
                                })
                                await session_manager.write(session.session_id, KILL_LINE + b"\r")
                                continue
                        await session_manager.write(session.session_id, b"\r")
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

    async def _control_listener():
        """Admin actions from any backend process: kill (D5), monitor notices (D4)."""
        pubsub = live.redis().pubsub()
        try:
            await pubsub.subscribe(live.channel("ctl", sid))
            async for msg in pubsub.listen():
                if stop_event.is_set():
                    break
                if msg.get("type") != "message":
                    continue
                ctl = json.loads(msg["data"])
                if ctl.get("action") == "kill":
                    terminated.update(by=ctl.get("by"), reason=ctl.get("reason"))
                    text = f"Session terminée par {ctl.get('by')}" + (f" : {ctl['reason']}" if ctl.get("reason") else "")
                    note = f"\r\n\x1b[1;31m[Citadel] {text}\x1b[0m\r\n"
                    try:
                        await websocket.send_json({"type": "output", "data": base64.b64encode(note.encode()).decode()})
                        await websocket.send_json({"type": "error", "message": text})
                    except Exception:  # noqa: BLE001
                        pass
                    stop_event.set()
                    break
                if ctl.get("action") == "watch":
                    note = f"\r\n\x1b[1;33m[Citadel] Cette session est observée par {ctl.get('by')}.\x1b[0m\r\n"
                    try:
                        await websocket.send_json({"type": "output", "data": base64.b64encode(note.encode()).decode()})
                    except Exception:  # noqa: BLE001
                        pass
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001
            logger.warning("control channel unavailable for %s", sid)
        finally:
            try:
                await pubsub.aclose()
            except Exception:  # noqa: BLE001
                pass

    # Run all tasks, cancel survivors when one exits
    tasks = [
        asyncio.create_task(_read_from_server()),
        asyncio.create_task(_read_from_client()),
        asyncio.create_task(_idle_watchdog()),
        asyncio.create_task(_control_listener()),
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

        try:
            await live.unregister(sid)
        except Exception:  # noqa: BLE001
            pass

        # Store the recording (D8) and close the audit trail
        try:
            async with async_session() as db:
                payload = json.dumps(recorder.events, separators=(",", ":")).encode()
                started = datetime.fromtimestamp(recorder.start_time, timezone.utc)
                key = f"ssh/{started:%Y/%m/%d}/{sid}.json.gz"
                stored = await recording_storage.store(db, key, payload)
                rec = (await db.execute(
                    select(SessionRecording).where(SessionRecording.session_id == sid))).scalar_one_or_none()
                if rec is None:
                    rec = SessionRecording(session_id=sid, server_id=srv_id, user_id=user_id,
                                           server_name=server_name, user_name=user_name, protocol="ssh")
                    db.add(rec)
                rec.events = None
                rec.storage_type, rec.storage_key, rec.sha256 = stored.storage_type, stored.key, stored.sha256
                rec.ended_at = datetime.now(timezone.utc)
                rec.duration_seconds = recorder.duration_seconds
                rec.event_count = recorder.event_count
                rec.size_bytes = recorder.size_bytes
                rec.terminated_by = terminated.get("by")
                rec.termination_reason = terminated.get("reason")
                db.add(AuditLog(
                    user_id=user_id,
                    server_id=srv_id,
                    action="terminal.close",
                    result=(f"Recorded {recorder.event_count} events, {recorder.duration_seconds}s"
                            + (f", killed by {terminated['by']}" if terminated.get("by") else "")),
                ))
                await db.commit()
        except Exception:  # noqa: BLE001
            logger.exception("failed to store recording %s", sid)
