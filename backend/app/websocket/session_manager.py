import asyncio
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

import asyncssh

from app.core.security import decrypt_value
from app.models.base import OSType


@dataclass
class TerminalSession:
    session_id: str
    server_id: str
    user_id: str
    os_type: OSType
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    _ssh_conn: asyncssh.SSHClientConnection | None = field(default=None, repr=False)
    _ssh_process: asyncssh.SSHClientProcess | None = field(default=None, repr=False)
    _closed: bool = False

    @property
    def is_closed(self) -> bool:
        return self._closed


class SessionManager:
    """Manages interactive terminal sessions across multiple servers."""

    def __init__(self):
        self._sessions: dict[str, TerminalSession] = {}

    async def create_ssh_session(
        self,
        server_id: str,
        user_id: str,
        host: str,
        port: int,
        username: str,
        password: bytes | None = None,
        ssh_key: bytes | None = None,
        use_ephemeral_cert: bool = False,
        cert_validity_minutes: int = 480,
        term_type: str = "xterm-256color",
        cols: int = 80,
        rows: int = 24,
    ) -> TerminalSession:
        """Open an interactive SSH PTY session."""
        connect_kwargs: dict = {
            "host": host,
            "port": port,
            "username": username,
            "known_hosts": None,
        }

        _cert_key_path = None

        if use_ephemeral_cert:
            from app.services.ca_service import sign_user_certificate
            key_path, cert_path = sign_user_certificate(
                username=username,
                validity_minutes=cert_validity_minutes,
            )
            _cert_key_path = key_path
            connect_kwargs["client_keys"] = [key_path]
        elif ssh_key:
            key_str = decrypt_value(ssh_key)
            connect_kwargs["client_keys"] = [asyncssh.import_private_key(key_str)]
        elif password:
            connect_kwargs["password"] = decrypt_value(password)
        else:
            raise ValueError("No password, SSH key, or ephemeral cert configured")

        try:
            conn = await asyncio.wait_for(asyncssh.connect(**connect_kwargs), timeout=10)
        finally:
            if _cert_key_path:
                from app.services.ca_service import cleanup_cert_files
                cleanup_cert_files(_cert_key_path)

        process = await conn.create_process(
            term_type=term_type,
            term_size=(cols, rows),
            encoding=None,  # binary mode for raw terminal data
        )

        session_id = str(uuid.uuid4())
        session = TerminalSession(
            session_id=session_id,
            server_id=server_id,
            user_id=user_id,
            os_type=OSType.LINUX,
            _ssh_conn=conn,
            _ssh_process=process,
        )
        self._sessions[session_id] = session
        return session

    async def write(self, session_id: str, data: bytes):
        """Send input data to the remote terminal."""
        session = self._sessions.get(session_id)
        if not session or session.is_closed:
            raise ValueError("Session not found or closed")

        if session.os_type == OSType.LINUX and session._ssh_process:
            session._ssh_process.stdin.write(data)

    async def read(self, session_id: str) -> bytes | None:
        """Read output data from the remote terminal. Returns None on EOF."""
        session = self._sessions.get(session_id)
        if not session or session.is_closed:
            return None

        if session.os_type == OSType.LINUX and session._ssh_process:
            try:
                data = await asyncio.wait_for(
                    session._ssh_process.stdout.read(4096),
                    timeout=0.1,
                )
                return data if data else None
            except asyncio.TimeoutError:
                return b""
            except asyncssh.TerminalSizeChanged:
                return b""

        return None

    async def resize(self, session_id: str, cols: int, rows: int):
        """Resize the remote terminal."""
        session = self._sessions.get(session_id)
        if not session or session.is_closed:
            return

        if session.os_type == OSType.LINUX and session._ssh_process:
            session._ssh_process.change_terminal_size(cols, rows)

    async def close(self, session_id: str):
        """Close a terminal session and release resources."""
        session = self._sessions.pop(session_id, None)
        if not session:
            return

        session._closed = True

        if session._ssh_process:
            session._ssh_process.stdin.write_eof()
            session._ssh_process.close()
        if session._ssh_conn:
            session._ssh_conn.close()

    async def close_all_for_user(self, user_id: str):
        """Close all sessions belonging to a user."""
        to_close = [
            sid for sid, s in self._sessions.items() if s.user_id == user_id
        ]
        for sid in to_close:
            await self.close(sid)

    def get_session(self, session_id: str) -> TerminalSession | None:
        return self._sessions.get(session_id)

    def list_sessions(self, user_id: str | None = None) -> list[TerminalSession]:
        sessions = list(self._sessions.values())
        if user_id:
            sessions = [s for s in sessions if s.user_id == user_id]
        return sessions


# Singleton
session_manager = SessionManager()
