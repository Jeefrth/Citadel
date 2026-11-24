"""SSH proxy (lot 7): connect to granted Linux servers with any SSH client.

    ssh -p 2222 <login>@citadel                    menu of servers
    ssh -p 2222 '<login>#<server>'@citadel          default (or only) account
    ssh -p 2222 '<login>#<account>#<server>'@citadel

<login> is the user's e-mail, or its local part when unique. Sign-in with a
public key registered in "Mon compte", or with a connection token (password,
1 minute to 24 hours). Everything else is the web terminal's path: login ACL,
access policy, connection ACL, command ACL per line, recording, live view,
admin kill, masking (services.terminal_core). No exec, no SFTP, no
forwarding: an interactive shell only.
"""

import asyncio
import base64
import hashlib
import hmac
import logging
from datetime import datetime, timezone

import asyncssh
from fastapi import HTTPException
from sqlalchemy import func, select

from app.core.config import settings
from app.core.database import async_session
from app.core.permissions import (
    ACCOUNT_INPUT, ACCOUNT_USER, compute_grants, require_server, resolve_for_user,
)
from app.core.security import decrypt_value, encrypt_value
from app.models.base import OSType
from app.models.identity import LoginEvent, SSHConnectToken, UserSSHKey
from app.models.pam import PolicyAction
from app.models.server import Server
from app.models.settings import AppSetting
from app.models.user import User
from app.services.enforcement import GovernanceDenied, enforce_connect
from app.services.terminal_core import SessionOpenError, SessionSpec, run_session

logger = logging.getLogger("citadel.ssh_proxy")
HOST_KEY_SETTING = "_ssh_proxy_host_key"
SEP = "#"
MENU_LIMIT = 200


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def parse_username(raw: str) -> tuple[str, str | None, str | None]:
    """'login' | 'login#server' | 'login#account#server' -> (login, account, server)."""
    parts = raw.split(SEP)
    if len(parts) == 1:
        return parts[0], None, None
    if len(parts) == 2:
        return parts[0], None, parts[1] or None
    return parts[0], parts[1] or None, SEP.join(parts[2:]) or None


async def find_user(db, login: str) -> User | None:
    login = login.strip().lower()
    if not login:
        return None
    users = (await db.execute(select(User).where(User.is_active.is_(True)))).scalars().all()
    exact = [u for u in users if (u.email or "").lower() == login]
    if exact:
        return exact[0]
    local = [u for u in users if (u.email or "").lower().split("@", 1)[0] == login]
    return local[0] if len(local) == 1 else None


async def _record(db, user: User | None, ip: str | None, result: str, reason: str | None, login: str) -> None:
    db.add(LoginEvent(user_id=user.id if user else None, user_name=user.display_name if user else login[:255],
                      method="ssh", result=result, reason=reason, ip_address=ip, user_agent="ssh"))
    await db.commit()


async def _login_allowed(db, user: User, ip: str | None) -> bool:
    from app.core.auth import enforce_login_acl
    try:
        await enforce_login_acl(db, user, ip, method="ssh", user_agent="ssh")
        return True
    except HTTPException:
        return False


class _ProxyServer(asyncssh.SSHServer):
    def __init__(self):
        self.ip: str | None = None
        self.user_id = None
        self.via: str = ""

    def connection_made(self, conn):
        peer = conn.get_extra_info("peername")
        self.ip = peer[0] if peer else None

    def begin_auth(self, username: str) -> bool:
        return True

    def password_auth_supported(self) -> bool:
        return True

    def public_key_auth_supported(self) -> bool:
        return True

    async def validate_public_key(self, username: str, key: asyncssh.SSHKey) -> bool:
        login = parse_username(username)[0]
        fp = key.get_fingerprint("sha256")
        async with async_session() as db:
            user = await find_user(db, login)
            row = None
            if user is not None:
                row = (await db.execute(select(UserSSHKey).where(
                    UserSSHKey.user_id == user.id, UserSSHKey.fingerprint == fp))).scalar_one_or_none()
            if row is None:
                return False  # the client may try another key: no failure logged per key
            if not await _login_allowed(db, user, self.ip):
                return False
            row.last_used_at = datetime.now(timezone.utc)
            await _record(db, user, self.ip, "success", f"clé {row.name}", login)
            self.user_id, self.via = user.id, f"clé {row.name}"
            return True

    async def validate_password(self, username: str, password: str) -> bool:
        login = parse_username(username)[0]
        now = datetime.now(timezone.utc)
        async with async_session() as db:
            user = await find_user(db, login)
            ok_row = None
            if user is not None:
                rows = (await db.execute(select(SSHConnectToken).where(
                    SSHConnectToken.user_id == user.id, SSHConnectToken.revoked.is_(False),
                    SSHConnectToken.expires_at > now))).scalars().all()
                digest = hash_token(password)
                ok_row = next((r for r in rows if hmac.compare_digest(r.token_hash, digest)), None)
            if ok_row is None:
                await _record(db, user, self.ip, "denied", "jeton invalide ou expiré", login)
                return False
            if not await _login_allowed(db, user, self.ip):
                return False
            ok_row.last_used_at = now
            await _record(db, user, self.ip, "success", "jeton de connexion", login)
            self.user_id, self.via = user.id, "jeton"
            return True


# ── interactive helpers ──────────────────────────────────

def _w(process, text: str) -> None:
    process.stdout.write(text.replace("\n", "\r\n").encode())


async def _read_line(process, prompt: str, echo: bool = True) -> str | None:
    _w(process, prompt)
    buf: list[str] = []
    while True:
        try:
            data = await process.stdin.read(1024)
        except asyncssh.TerminalSizeChanged:
            continue
        except (asyncssh.BreakReceived, asyncssh.SignalReceived):
            return None
        if not data:
            return None
        for ch in data.decode("utf-8", errors="ignore"):
            if ch in ("\r", "\n"):
                _w(process, "\n")
                return "".join(buf).strip()
            if ch in ("\x03", "\x04"):
                _w(process, "\n")
                return None
            if ch in ("\x7f", "\b"):
                if buf:
                    buf.pop()
                    if echo:
                        _w(process, "\b \b")
                continue
            if ch >= " ":
                buf.append(ch)
                if echo:
                    _w(process, ch)


async def _visible_linux(db, user: User, name: str | None = None) -> list[Server]:
    grants = await compute_grants(db, user)
    stmt = select(Server).where(Server.os_type == OSType.LINUX).order_by(Server.name, Server.ip_address)
    if name:
        stmt = stmt.where(func.lower(Server.name) == name.lower())
    return [s for s in (await db.execute(stmt)).scalars().all()
            if grants is None or (s.id in grants and PolicyAction.CONNECT.value in grants[s.id].actions)]


async def _pick_server(process, db, user: User, preset: list[Server] | None = None) -> Server | None:
    servers = preset if preset is not None else await _visible_linux(db, user)
    if not servers:
        _w(process, "Aucun serveur Linux ne vous est accordé.\n")
        return None
    query = ""
    while True:
        shown = [s for s in servers if query.lower() in f"{s.name} {s.ip_address} {s.hostname or ''}".lower()][:MENU_LIMIT]
        _w(process, "\n")
        for i, s in enumerate(shown, 1):
            _w(process, f"  {i:>3}  {s.name:<32} {s.ip_address}\n")
        if not shown:
            _w(process, "  (aucun serveur ne correspond)\n")
        answer = await _read_line(process, "\nNuméro, texte pour filtrer, q pour quitter : ")
        if answer is None or answer.lower() in ("q", "quit", "exit"):
            return None
        if answer.isdigit() and 1 <= int(answer) <= len(shown):
            return shown[int(answer) - 1]
        query = answer


async def _pick_account(process, server: Server, grant, user: User, wanted: str | None, ask: bool = True):
    """Returns resolve_for_user kwargs, or None to quit."""
    options = []
    for a in server.accounts:
        if a.is_active and grant.allows_account(a.username):
            options.append((a.username + (" (par défaut)" if a.is_default else ""), {"account_id": str(a.id)}, a.username))
    if ACCOUNT_USER in grant.accounts:
        options.append(("@USER (certificat à votre nom)", {"virtual": ACCOUNT_USER}, ACCOUNT_USER))
    if ACCOUNT_INPUT in grant.accounts:
        options.append(("@INPUT (identifiants saisis)", {"virtual": ACCOUNT_INPUT}, ACCOUNT_INPUT))
    if wanted:
        match = next((o for o in options if o[2] == wanted), None)
        if match is None:
            _w(process, f"Compte « {wanted} » non accordé sur {server.name}.\n")
            return None
        choice = match
    elif not options:
        _w(process, f"Aucun compte accordé sur {server.name}.\n")
        return None
    elif len(options) == 1:
        choice = options[0]
    elif not ask and any("par défaut" in o[0] for o in options):
        choice = next(o for o in options if "par défaut" in o[0])  # direct target: default account
    else:
        _w(process, f"\nComptes sur {server.name} :\n")
        for i, o in enumerate(options, 1):
            _w(process, f"  {i:>3}  {o[0]}\n")
        answer = await _read_line(process, "Numéro du compte : ")
        if not answer or not answer.isdigit() or not 1 <= int(answer) <= len(options):
            return None
        choice = options[int(answer) - 1]
    kwargs = dict(choice[1])
    if kwargs.get("virtual") == ACCOUNT_INPUT:
        name = await _read_line(process, "Utilisateur : ")
        pwd = await _read_line(process, "Mot de passe : ", echo=False)
        if not name or not pwd:
            return None
        kwargs.update(input_username=name, input_password=pwd)
    return kwargs


class _SSHFrontend:
    def __init__(self, process):
        self.p = process

    async def send_output(self, data: bytes) -> None:
        self.p.stdout.write(data)
        await self.p.stdout.drain()

    async def notice(self, text: str) -> None:
        self.p.stdout.write(f"\r\n\x1b[1;33m[Citadel] {text}\x1b[0m\r\n".encode())

    async def connected(self, session_id: str) -> None:
        pass

    async def disconnected(self) -> None:
        pass

    async def receive(self):
        try:
            data = await self.p.stdin.read(4096)
        except asyncssh.TerminalSizeChanged as e:
            return ("resize", e.width, e.height)
        except asyncssh.BreakReceived:
            return ("input", b"\x03")
        except asyncssh.SignalReceived:
            return ("input", b"\x03")
        except Exception:  # noqa: BLE001
            return None
        if not data:
            return None
        return ("input", data)


async def _handle(process) -> None:
    owner: _ProxyServer = process.get_extra_info("connection").get_owner()
    try:
        if process.command is not None or process.subsystem is not None:
            process.stderr.write(b"Citadel: interactive shell only (no exec, no sftp).\r\n")
            process.exit(1)
            return
        if process.get_terminal_type() is None:
            process.stderr.write(b"Citadel: a terminal is required (ssh -t).\r\n")
            process.exit(1)
            return
        cols, rows = process.get_terminal_size()[:2]
        _login, wanted_account, wanted_server = parse_username(process.get_extra_info("username") or "")
        async with async_session() as db:
            user = await db.get(User, owner.user_id)
            if user is None or not user.is_active:
                process.exit(1)
                return
            _w(process, f"Citadel : bonjour {user.display_name}.\n")
            server = None
            if wanted_server:
                matches = await _visible_linux(db, user, name=wanted_server)
                if not matches:
                    _w(process, f"Serveur « {wanted_server} » introuvable.\n")
                    process.exit(1)
                    return
                if len(matches) == 1:
                    server = matches[0]
                else:  # names are not unique: let the user pick
                    _w(process, f"Plusieurs serveurs s'appellent « {wanted_server} ».\n")
                    server = await _pick_server(process, db, user, preset=matches)
            else:
                server = await _pick_server(process, db, user)
                if server is None:
                    process.exit(0)
                    return
            try:
                server, grant = await require_server(db, user, server.id, PolicyAction.CONNECT.value)
            except HTTPException:
                _w(process, f"Serveur « {server.name} » introuvable.\n")  # same answer as an unknown server
                process.exit(1)
                return
            if server.os_type != OSType.LINUX:
                _w(process, "Ce serveur est sous Windows : utilisez le RDP depuis l'interface web.\n")
                process.exit(1)
                return
            kwargs = await _pick_account(process, server, grant, user, wanted_account, ask=not wanted_server)
            if kwargs is None:
                process.exit(1)
                return
            try:
                account = resolve_for_user(server, grant, user, **kwargs)
                await enforce_connect(db, user, server, account.username, owner.ip)
            except HTTPException as e:
                _w(process, f"Refusé : {e.detail}\n")
                process.exit(1)
                return
            except GovernanceDenied as e:
                _w(process, f"{e.message}\n")
                process.exit(1)
                return
        _w(process, f"Connexion à {server.name} ({account.label})...\n")
        spec = SessionSpec(user=user, server=server, account=account, ip=owner.ip, cols=cols or 80, rows=rows or 24,
                           channel="ssh-proxy")
        try:
            await run_session(spec, _SSHFrontend(process))
        except SessionOpenError as e:
            _w(process, f"{e}\n")
            process.exit(1)
            return
        process.exit(0)
    except (asyncssh.BreakReceived, asyncssh.TerminalSizeChanged, BrokenPipeError, ConnectionError):
        process.exit(1)
    except Exception:  # noqa: BLE001
        logger.exception("ssh proxy session failed")
        try:
            process.exit(1)
        except Exception:  # noqa: BLE001
            pass


async def _host_key(db) -> asyncssh.SSHKey:
    row = (await db.execute(select(AppSetting).where(AppSetting.key == HOST_KEY_SETTING))).scalar_one_or_none()
    if row is not None:
        return asyncssh.import_private_key(decrypt_value(base64.b64decode(row.value)))
    key = asyncssh.generate_private_key("ssh-ed25519")
    pem = key.export_private_key().decode()
    db.add(AppSetting(key=HOST_KEY_SETTING, value=base64.b64encode(encrypt_value(pem)).decode(),
                      description="Clé d'hôte du proxy SSH (chiffrée)"))
    await db.commit()
    return key


async def host_fingerprint() -> str | None:
    async with async_session() as db:
        row = (await db.execute(select(AppSetting).where(AppSetting.key == HOST_KEY_SETTING))).scalar_one_or_none()
        if row is None:
            return None
        return asyncssh.import_private_key(decrypt_value(base64.b64decode(row.value))).get_fingerprint("sha256")


async def serve(stop: asyncio.Event) -> None:
    async with async_session() as db:
        key = await _host_key(db)
    server = None
    while server is None and not stop.is_set():
        try:
            server = await asyncssh.create_server(
                _ProxyServer, "", settings.SSH_PROXY_PORT, server_host_keys=[key], process_factory=_handle,
                encoding=None, line_editor=False, allow_scp=False, agent_forwarding=False,
                x11_forwarding=False, login_timeout=60, keepalive_interval=30,
            )
        except OSError as e:  # port still held by a previous process (reload): retry
            logger.warning("SSH proxy: cannot bind %s (%s), retrying in 5 s", settings.SSH_PROXY_PORT, e)
            try:
                await asyncio.wait_for(stop.wait(), 5)
            except asyncio.TimeoutError:
                pass
    if server is None:
        return
    logger.info("SSH proxy listening on %s (host key %s)", settings.SSH_PROXY_PORT, key.get_fingerprint("sha256"))
    try:
        await stop.wait()
    finally:
        server.close()
