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
from app.services import k8s, k8s_access, k8s_session, tui_select
from app.services.terminal_core import SessionOpenError, SessionSpec, run_session

logger = logging.getLogger("citadel.ssh_proxy")
HOST_KEY_SETTING = "_ssh_proxy_host_key"
_background: set = set()
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


def split_org(target: str | None) -> tuple[str | None, str | None]:
    """'acme:web01' -> ('acme', 'web01'); organisation prefix of a direct target."""
    if target and ":" in target:
        org, rest = target.split(":", 1)
        return (org.strip().lower() or None), (rest or None)
    return None, target


async def _record(db, user: User | None, ip: str | None, result: str, reason: str | None, login: str) -> None:
    from app.core.tenancy import current_org_id
    db.add(LoginEvent(user_id=user.id if user else None, user_name=user.display_name if user else login[:255],
                      org_id=current_org_id(),
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
        self.conn = None
        self.ip: str | None = None
        self.user_id = None
        self.via: str = ""
        self.key_id = None
        # public key auth: asyncssh asks about a key BEFORE the client proves it holds
        # the private key; nothing is decided or logged until auth_completed()
        self._pending_key: dict[str, tuple] = {}

    def connection_made(self, conn):
        self.conn = conn
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
        self._pending_key[username] = (user.id, row.id, row.name, login)
        return True

    def auth_completed(self) -> None:
        """Called once the signature (or the password) has been verified."""
        if self.user_id is not None:
            return  # password: already recorded in validate_password
        username = self.conn.get_extra_info("username") if self.conn else None
        pending = self._pending_key.get(username or "")
        if pending is None:
            return
        user_id, key_id, key_name, login = pending
        self.user_id, self.via, self.key_id = user_id, f"clé {key_name}", key_id
        # sign-in recorded by the session once the organisation is known

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
            ok_row.last_used_at = now
            await db.commit()
            self.user_id, self.via = user.id, "jeton de connexion"
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


async def _node_paths(db) -> dict:
    from app.models.pam import Node
    nodes = {n.id: n for n in (await db.execute(select(Node))).scalars().all()}

    def path(nid):
        parts, seen = [], set()
        while nid in nodes and nid not in seen:
            seen.add(nid)
            parts.append(nodes[nid].name)
            nid = nodes[nid].parent_id
        return "/".join(reversed(parts))
    return {nid: path(nid) for nid in nodes}


async def _k8s_targets(db, user: User) -> list[tuple]:
    """(cluster, grant) for active clusters where the user may open a shell somewhere."""
    from app.models.kubernetes import K8sCluster
    grants = await k8s_access.grants(db, user)
    out = []
    for c in (await db.execute(select(K8sCluster).where(K8sCluster.is_active.is_(True))
                               .order_by(K8sCluster.name))).scalars().all():
        g = k8s_access.FULL if grants is None else grants.get(str(c.id))
        if g is not None and any("exec" in acts for acts, _ in g.rules):
            out.append((c, g))
    return out


async def _pick_server(process, db, user: User, preset: list[Server] | None = None, title: str | None = None):
    """Interactive list of servers (and Kubernetes clusters in the main menu).
    Returns a Server, ("k8s", cluster, grant), or None to quit."""
    servers = preset if preset is not None else await _visible_linux(db, user)
    clusters = [] if preset is not None else await _k8s_targets(db, user)
    if not servers and not clusters:
        _w(process, "Aucun serveur Linux ni cluster Kubernetes ne vous est accordé.\n")
        return None
    paths = await _node_paths(db)
    items = []
    for s in servers:
        tags = " ".join(f"{k}={v}" for k, v in sorted((s.tags or {}).items()) if not k.startswith("azure_"))
        detail = "   ".join(x for x in (s.ip_address, paths.get(s.node_id, ""), tags) if x)
        items.append(tui_select.Item(s.name, detail, s))
    for c, g in clusters:
        items.append(tui_select.Item(c.name, f"Kubernetes   {c.api_url}", ("k8s", c, g)))
    sel = tui_select.Selector(title or f"Citadel : bonjour {user.display_name}. Choisissez un serveur ou un cluster", items,
                              hint="↑↓ choisir   Entrée se connecter   Échap quitter   tapez pour filtrer")
    choice = await tui_select.select(process, sel)
    return choice.value if isinstance(choice, tui_select.Item) else None


async def _pick_account(process, server: Server, grant, user: User, wanted: str | None, ask: bool = True,
                        can_go_back: bool = False):
    """resolve_for_user kwargs, "back" (Esc, when a server list is behind), or None to quit."""
    options = []
    for a in server.accounts:
        if a.is_active and grant.allows_account(a.username):
            options.append(tui_select.Item(a.username, "compte par défaut" if a.is_default else "",
                                           ({"account_id": str(a.id)}, a.username, a.is_default)))
    if ACCOUNT_USER in grant.accounts:
        options.append(tui_select.Item("@USER", "certificat éphémère à votre nom", ({"virtual": ACCOUNT_USER}, ACCOUNT_USER, False)))
    if ACCOUNT_INPUT in grant.accounts:
        options.append(tui_select.Item("@INPUT", "identifiants saisis à la connexion", ({"virtual": ACCOUNT_INPUT}, ACCOUNT_INPUT, False)))
    if wanted:
        choice = next((o for o in options if o.value[1] == wanted), None)
        if choice is None:
            _w(process, f"Compte « {wanted} » non accordé sur {server.name}.\n")
            return None
    elif not options:
        _w(process, f"Aucun compte accordé sur {server.name}.\n")
        return "back" if can_go_back else None
    elif len(options) == 1:
        choice = options[0]
    elif not ask and any(o.value[2] for o in options):
        choice = next(o for o in options if o.value[2])  # direct target: default account
    else:
        sel = tui_select.Selector(f"{server.name} : choisissez un compte", options,
                                  hint="↑↓ choisir   Entrée se connecter   Échap "
                                       + ("retour aux serveurs" if can_go_back else "quitter"))
        choice = await tui_select.select(process, sel)
        if choice == "back":
            return "back" if can_go_back else None
        if not isinstance(choice, tui_select.Item):
            return None
    kwargs = dict(choice.value[0])
    if kwargs.get("virtual") == ACCOUNT_INPUT:
        name = await _read_line(process, f"Utilisateur sur {server.name} : ")
        pwd = await _read_line(process, "Mot de passe : ", echo=False)
        if not name or not pwd:
            return None
        kwargs.update(input_username=name, input_password=pwd)
    return kwargs


async def _k8s_pick(process, db, user: User, cluster, grant, ip, cols, rows, back_label: str):
    """Namespace, then pod, then container. Returns a SessionSpec, "back", or None (quit / refused)."""
    try:
        namespaces = [n for n in await k8s.namespaces(cluster) if grant.can("exec", n["name"])]
    except k8s.K8sError as e:
        _w(process, f"Cluster {cluster.name} injoignable : {e}\n")
        return None
    if not namespaces:
        _w(process, f"Aucun espace de noms de {cluster.name} ne vous permet d'ouvrir un shell.\n")
        return "back"
    hint = "↑↓ choisir   Entrée valider   Échap "
    while True:
        sel = tui_select.Selector(f"{cluster.name} : choisissez un espace de noms",
                                  [tui_select.Item(n["name"], n.get("status") or "", n["name"]) for n in namespaces],
                                  hint=hint + back_label)
        ns = await tui_select.select(process, sel)
        if ns == "back":
            return "back"
        if not isinstance(ns, tui_select.Item):
            return None
        ns = ns.value
        while True:
            try:
                pods = [p for p in await k8s.pods(cluster, ns) if p["phase"] == "Running"]
            except k8s.K8sError as e:
                _w(process, f"{e}\n")
                return None
            if not pods:
                sel = tui_select.Selector(f"{cluster.name}/{ns} : aucun pod en cours d'exécution", [],
                                          hint=hint + "retour aux espaces de noms")
                if await tui_select.select(process, sel) is None:
                    return None
                break
            items = [tui_select.Item(p["name"], f"{p['ready']} prêts   {p['restarts']} redémarrage(s)   "
                                                f"{', '.join(p['containers'])}", p) for p in pods]
            sel = tui_select.Selector(f"{cluster.name}/{ns} : choisissez un pod", items,
                                      hint=hint + "retour aux espaces de noms")
            pod = await tui_select.select(process, sel)
            if pod == "back":
                break
            if not isinstance(pod, tui_select.Item):
                return None
            pod = pod.value
            container = pod["containers"][0] if pod["containers"] else None
            if len(pod["containers"]) > 1:
                sel = tui_select.Selector(f"{pod['name']} : choisissez un conteneur",
                                          [tui_select.Item(c, "", c) for c in pod["containers"]],
                                          hint=hint + "retour aux pods")
                c = await tui_select.select(process, sel)
                if c == "back":
                    continue
                if not isinstance(c, tui_select.Item):
                    return None
                container = c.value
            try:
                return await k8s_session.prepare(db, user, cluster.id, ns, pod["name"], container, ip,
                                                 cols=cols, rows=rows, channel="k8s")
            except k8s_session.K8sSessionDenied as e:
                _w(process, f"Refusé : {e.message}\n")
                return None


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


async def _enter_org(process, db, user: User, wanted: str | None) -> bool:
    from app.core.auth import bind_user, user_orgs
    choices = await user_orgs(db, user)
    if wanted:
        choices = [om for om in choices if om[0].slug == wanted]
        if not choices:
            _w(process, f"Organisation « {wanted} » inconnue ou non autorisée.\n")
            return False
    if not choices:
        _w(process, "Ce compte n'appartient à aucune organisation.\n")
        return False
    if len(choices) == 1:
        org, m = choices[0]
    else:
        picked = await tui_select.select(process, tui_select.Selector(
            "Organisation", [tui_select.Item(o.name, o.slug, (o, m)) for o, m in choices]))
        if picked is None or picked == "back":
            return False
        org, m = picked.value
    await bind_user(db, user, org, m)
    return True


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
        login, wanted_account, wanted_server = parse_username(process.get_extra_info("username") or "")
        wanted_org, wanted_server = split_org(wanted_server)
        async with async_session() as db:
            user = await db.get(User, owner.user_id) if owner.user_id else None
            if user is None or not user.is_active:
                process.exit(1)
                return
            # Organisation: prefix of the target, the only one, or chosen in a menu
            if not await _enter_org(process, db, user, wanted_org):
                process.exit(1)
                return
            if owner.key_id is not None:
                row = await db.get(UserSSHKey, owner.key_id)
                if row is not None:
                    row.last_used_at = datetime.now(timezone.utc)
            if not await _login_allowed(db, user, owner.ip):
                _w(process, "Connexion à Citadel refusée par une règle de connexion.\n")
                process.exit(1)
                return
            await _record(db, user, owner.ip, "success", owner.via, login)
            k8s_spec = None
            if wanted_server and wanted_server.startswith("k8s/"):
                # direct: login#k8s/<cluster>/<namespace>/<pod>[/<container>]
                parts = wanted_server.split("/")
                from app.models.kubernetes import K8sCluster
                cluster = (await db.execute(select(K8sCluster).where(
                    func.lower(K8sCluster.name) == (parts[1] if len(parts) > 1 else "").lower()))).scalars().first()
                if cluster is None or len(parts) not in (4, 5):
                    _w(process, "Cible Kubernetes : <login>#k8s/<cluster>/<espace de noms>/<pod>[/<conteneur>]\n")
                    process.exit(1)
                    return
                try:
                    k8s_spec = await k8s_session.prepare(db, user, cluster.id, parts[2], parts[3],
                                                         parts[4] if len(parts) == 5 else None, owner.ip,
                                                         channel="k8s")
                except k8s_session.K8sSessionDenied as e:
                    _w(process, f"Refusé : {e.message}\n")
                    process.exit(1)
                    return
            preset = None
            if wanted_server and k8s_spec is None:
                matches = await _visible_linux(db, user, name=wanted_server)
                if not matches:
                    _w(process, f"Serveur « {wanted_server} » introuvable.\n")
                    process.exit(1)
                    return
                if len(matches) > 1:  # names are not unique: let the user pick
                    preset = matches
            menu = not wanted_server or preset is not None
            while k8s_spec is None:
                if menu:
                    title = f"Plusieurs serveurs s'appellent « {wanted_server} »" if preset else None
                    server = await _pick_server(process, db, user, preset=preset, title=title)
                    if server is None:
                        process.exit(0)
                        return
                    if isinstance(server, tuple):  # a Kubernetes cluster
                        c, r = process.get_terminal_size()[:2]
                        res = await _k8s_pick(process, db, user, server[1], server[2], owner.ip, c or 80, r or 24,
                                              "retour au menu")
                        if res == "back":
                            continue
                        if res is None:
                            process.exit(1)
                            return
                        k8s_spec = res
                        break
                else:
                    server = matches[0]
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
                kwargs = await _pick_account(process, server, grant, user, wanted_account,
                                             ask=menu, can_go_back=menu)
                if kwargs == "back":
                    continue
                if kwargs is None:
                    process.exit(1)
                    return
                break
            if k8s_spec is None:
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
        cols, rows = process.get_terminal_size()[:2]  # may have changed during the menu
        if k8s_spec is not None:
            spec = k8s_spec
            spec.cols, spec.rows = cols or 80, rows or 24
            _w(process, f"Connexion à {spec.server.name}...\n")
        else:
            _w(process, f"Connexion à {server.name} ({account.label})...\n")
            spec = SessionSpec(user=user, server=server, account=account, ip=owner.ip, cols=cols or 80,
                               rows=rows or 24, channel="ssh-proxy")
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
    row = (await db.execute(select(AppSetting).where(AppSetting.key == HOST_KEY_SETTING, AppSetting.org_id.is_(None)))).scalar_one_or_none()
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
        row = (await db.execute(select(AppSetting).where(AppSetting.key == HOST_KEY_SETTING, AppSetting.org_id.is_(None)))).scalar_one_or_none()
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
