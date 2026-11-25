"""Interactive SSH session core, shared by the web terminal (WebSocket) and the
SSH proxy (lot 7): recording, command ACL on each line, live monitoring,
admin kill, idle / certificate limits, data masking, audit.

Callers authenticate the user, check the access policy and the connection
ACL, then hand over a Frontend (how bytes reach the user) to run_session().
"""

import asyncio
import base64
import json
import logging
import time
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Protocol

from sqlalchemy import select

from app.core.database import async_session
from app.core.permissions import ResolvedAccount
from app.models.audit import AuditLog
from app.models.server import Server
from app.models.session_recording import SessionRecording
from app.models.user import User
from app.services import live, masking, recording_storage, routing
from app.services.command_log import log_command
from app.services.enforcement import check_command
from app.websocket.line_tracker import KILL_LINE, LineTracker
from app.websocket.session_manager import session_manager

logger = logging.getLogger("citadel.terminal")
IDLE_TIMEOUT = 1800  # 30 minutes


class Frontend(Protocol):
    async def send_output(self, data: bytes) -> None: ...
    async def notice(self, text: str) -> None: ...          # out-of-band message (error / warning)
    async def receive(self): ...                           # ("input", bytes) | ("resize", cols, rows) | None
    async def connected(self, session_id: str) -> None: ...
    async def disconnected(self) -> None: ...


class SessionOpenError(RuntimeError):
    pass


class SessionRecorder:
    """All terminal I/O events with timestamps, for replay."""

    def __init__(self):
        self.events: list[dict] = []
        self.start_time: float = time.time()
        self.size_bytes: int = 0

    def _add(self, kind: str, data: bytes):
        self.events.append({"t": int((time.time() - self.start_time) * 1000), "type": kind,
                            "data": base64.b64encode(data).decode("ascii")})
        self.size_bytes += len(data)

    def record_output(self, data: bytes):
        self._add("o", data)

    def record_input(self, data: bytes):
        self._add("i", data)

    @property
    def duration_seconds(self) -> int:
        return int(time.time() - self.start_time)

    @property
    def event_count(self) -> int:
        return len(self.events)


def _red(text: str) -> bytes:
    return f"\r\n\x1b[1;31m[Citadel] {text}\x1b[0m\r\n".encode()


class TargetChannel(Protocol):
    """The remote side of a session: an SSH shell, a container exec..."""
    session_id: str
    async def read(self) -> bytes | None: ...   # None = closed
    async def write(self, data: bytes) -> None: ...
    async def resize(self, cols: int, rows: int) -> None: ...
    async def close(self) -> None: ...


class _SSHChannel:
    def __init__(self, session_id: str):
        self.session_id = session_id

    async def read(self):
        return await session_manager.read(self.session_id)

    async def write(self, data: bytes):
        await session_manager.write(self.session_id, data)

    async def resize(self, cols: int, rows: int):
        await session_manager.resize(self.session_id, cols, rows)

    async def close(self):
        await session_manager.close(self.session_id)


@dataclass
class SessionSpec:
    user: User
    server: Server                 # a Server, or a target with the same shape (is_k8s, link, name, node_id, tags)
    account: ResolvedAccount
    ip: str | None
    cols: int = 80
    rows: int = 24
    cert_minutes: int | None = None
    channel: str = "web"           # web | ssh-proxy | k8s (audit and live view)
    protocol: str = "ssh"          # recording protocol
    open_channel: object = None    # async (cols, rows) -> TargetChannel; None = SSH to the server
    route: object = None           # what routing.via() gets (default: server)
    extra: dict = field(default_factory=dict)


async def run_session(spec: SessionSpec, fe: Frontend) -> None:
    """Open the SSH session to the target and pump it until either side ends.
    Raises SessionOpenError if the target can't be reached (nothing recorded)."""
    user, server, account, ip = spec.user, spec.server, spec.account, spec.ip
    use_cert = account.use_cert
    cert_minutes = spec.cert_minutes or account.cert_minutes or 480
    route_stack = AsyncExitStack()
    is_server = not getattr(server, "is_k8s", False)
    try:
        await route_stack.enter_async_context(routing.via(spec.route or server))
        if spec.open_channel is not None:
            ch = await spec.open_channel(spec.cols, spec.rows)
        else:
            session = await session_manager.create_ssh_session(
                server_id=str(server.id), user_id=str(user.id), host=server.ip_address, port=server.ssh_port,
                username=account.username, password=account.password, ssh_key=account.ssh_key,
                use_ephemeral_cert=use_cert, cert_validity_minutes=cert_minutes, cols=spec.cols, rows=spec.rows,
            )
            ch = _SSHChannel(session.session_id)
    except Exception as e:  # noqa: BLE001
        await route_stack.aclose()
        raise SessionOpenError(f"Connection failed: {e}") from e

    server_name, user_name, user_id = server.name, user.display_name, user.id
    srv_id = server.id if is_server else None          # FK to servers
    live_target_id = str(server.id)
    acl_target = None if is_server else server        # non-server targets are passed as is
    cert_max_seconds = cert_minutes * 60 if (use_cert and spec.open_channel is None) else None
    sid = ch.session_id

    async with async_session() as db:
        masker = await masking.load(db)
        db.add(AuditLog(
            user_id=user_id, server_id=srv_id, action="terminal.open", ip_address=ip,
            result=(f"account={account.label} via={spec.channel} "
                    + (f"cert={cert_max_seconds}s" if cert_max_seconds else "password/key")),
        ))
        # Recording row created at start: an interrupted session still leaves a trace
        db.add(SessionRecording(
            session_id=sid, server_id=srv_id, user_id=user_id, server_name=server_name, user_name=user_name,
            protocol=spec.protocol, account=account.label, client_ip=ip, events=None,
        ))
        await db.commit()

    recorder = SessionRecorder()
    tracker = LineTracker()
    stop_event = asyncio.Event()
    last_activity = time.time()
    session_start = time.time()
    terminated: dict = {}

    await fe.connected(sid)
    try:
        await live.register(sid, {
            "protocol": "ssh", "user_id": str(user_id), "user": user_name, "server_id": live_target_id,
            "server": server_name, "account": account.label, "client_ip": ip, "channel": spec.channel,
        })
    except Exception:  # noqa: BLE001 - live monitoring must never block a session
        logger.warning("live registry unavailable for %s", sid)

    async def _watchdog():
        while not stop_event.is_set():
            await asyncio.sleep(10)
            try:
                await live.heartbeat(sid, last_activity=last_activity)
            except Exception:  # noqa: BLE001
                pass
            if cert_max_seconds:
                remaining = cert_max_seconds - (time.time() - session_start)
                if remaining <= 0:
                    await _safe(fe.notice(f"Certificat expiré : session fermée après {cert_max_seconds // 60} minutes"))
                    stop_event.set()
                    break
                if 290 < remaining <= 300:
                    await _safe(fe.notice("Attention : la session expire dans 5 minutes"))
                elif 50 < remaining <= 60:
                    await _safe(fe.notice(f"Attention : la session expire dans {int(remaining)} secondes"))
            if time.time() - last_activity > IDLE_TIMEOUT:
                await _safe(fe.notice(f"Session fermée après {IDLE_TIMEOUT // 60} minutes d'inactivité"))
                stop_event.set()
                break

    async def _from_server():
        try:
            while not stop_event.is_set():
                data = await ch.read()
                if data is None:
                    await _safe(fe.disconnected())
                    break
                if not data:
                    continue
                tracker.on_output(data)          # the tracker sees the real echo
                shown = masker.apply(data)
                recorder.record_output(shown)
                try:
                    await live.publish_output(sid, base64.b64encode(shown).decode("ascii"))
                except Exception:  # noqa: BLE001
                    pass
                try:
                    await fe.send_output(shown)
                except Exception:  # noqa: BLE001
                    break
        except Exception:  # noqa: BLE001
            pass
        finally:
            stop_event.set()

    async def _from_user():
        nonlocal last_activity
        try:
            while not stop_event.is_set():
                ev = await fe.receive()
                if ev is None:
                    break
                last_activity = time.time()
                if ev[0] == "resize":
                    await ch.resize(ev[1], ev[2])
                    continue
                data = ev[1]
                recorder.record_input(data)
                for chunk, enter in tracker.split(data):
                    if chunk:
                        tracker.feed(chunk)
                        await ch.write(chunk)
                    if not enter:
                        continue
                    in_app = tracker.alt_screen
                    if not in_app:
                        await tracker.settle()
                    command = tracker.take_line()
                    if command:
                        async with async_session() as cdb:
                            from app.services.members import load_member
                            cuser = await load_member(cdb, user_id, require_active=False) or await cdb.get(User, user_id)
                            cserver = acl_target or await cdb.get(Server, srv_id)
                            outcome = await check_command(cdb, cuser, cserver, account.username, command, ip,
                                                          source="terminal")
                            # full-screen app: journal only what gets blocked (a faked
                            # alternate screen must not switch the ACL off)
                            if not in_app or not outcome.allowed:
                                await log_command(
                                    cdb, user=cuser, server=cserver, account=account.label,
                                    command=masker.apply(command.encode()).decode(errors="replace"),
                                    source="terminal", decision=outcome.decision, rule=outcome.rule,
                                    session_id=sid, ip=ip,
                                    offset_ms=int((time.time() - recorder.start_time) * 1000))
                        if not outcome.allowed:
                            await fe.send_output(_red(outcome.message))
                            if in_app:
                                continue  # Enter withheld; nothing typed into the app
                            # Never send Enter: clear the typed line, get a fresh prompt
                            await ch.write(KILL_LINE + b"\r")
                            continue
                    await ch.write(b"\r")
        except Exception:  # noqa: BLE001
            pass
        finally:
            stop_event.set()

    async def _control():
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
                    await _safe(fe.send_output(_red(text)))
                    await _safe(fe.notice(text))
                    stop_event.set()
                    break
                if ctl.get("action") == "watch":
                    note = f"\r\n\x1b[1;33m[Citadel] Cette session est observée par {ctl.get('by')}.\x1b[0m\r\n"
                    await _safe(fe.send_output(note.encode()))
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001
            logger.warning("control channel unavailable for %s", sid)
        finally:
            try:
                await pubsub.aclose()
            except Exception:  # noqa: BLE001
                pass

    tasks = [asyncio.create_task(t()) for t in (_from_server, _from_user, _watchdog, _control)]
    try:
        await stop_event.wait()
        await asyncio.sleep(0.5)
    finally:
        for t in tasks:
            t.cancel()
        await ch.close()
        await route_stack.aclose()
        try:
            await live.unregister(sid)
        except Exception:  # noqa: BLE001
            pass
        await _store(sid, recorder, terminated, srv_id, user_id, server_name, user_name, masker.hits, spec.protocol)


async def _safe(coro) -> None:
    try:
        await coro
    except Exception:  # noqa: BLE001
        pass


async def _store(sid, recorder, terminated, srv_id, user_id, server_name, user_name, masked_hits,
                 protocol: str = "ssh") -> None:
    """Store the recording (D8) and close the audit trail."""
    try:
        async with async_session() as db:
            payload = json.dumps(recorder.events, separators=(",", ":")).encode()
            started = datetime.fromtimestamp(recorder.start_time, timezone.utc)
            stored = await recording_storage.store(db, f"{protocol}/{started:%Y/%m/%d}/{sid}.json.gz", payload)
            rec = (await db.execute(select(SessionRecording).where(SessionRecording.session_id == sid))).scalar_one_or_none()
            if rec is None:
                rec = SessionRecording(session_id=sid, server_id=srv_id, user_id=user_id,
                                       server_name=server_name, user_name=user_name, protocol=protocol)
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
                user_id=user_id, server_id=srv_id, action="terminal.close",
                result=(f"Recorded {recorder.event_count} events, {recorder.duration_seconds}s"
                        + (f", {masked_hits} masked" if masked_hits else "")
                        + (f", killed by {terminated['by']}" if terminated.get("by") else "")),
            ))
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.exception("failed to store recording %s", sid)
