"""Network routing through SSH gateways (A4).

Callers that know which server they talk to declare its route once:

    async with routing.via(server):
        await ssh_service.execute_command(host=server.ip_address, ...)

Low-level connectors then look the host up in the current context:
- SSH (asyncssh): `tunnel_for(host)` returns a gateway connection used as
  asyncssh `tunnel=` (jump host);
- WinRM / RDP / Ansible: `tcp_endpoint(host, port)` opens a local port
  forward through the gateway and returns the address to connect to.

Gateways of a zone are tried by priority (failover). Connections and port
forwards live as long as the `via()` block (a whole terminal / RDP session
for interactive use). Servers without a zone are untouched (direct).
"""

import asyncio
import contextvars
import logging
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone

import asyncssh

from app.core.security import decrypt_value

logger = logging.getLogger("citadel.routing")

# Hostname under which other containers (guacd) reach this backend
BACKEND_INTERNAL_HOST = os.environ.get("BACKEND_INTERNAL_HOST", "backend")


@dataclass
class GatewaySpec:
    id: str
    name: str
    host: str
    port: int
    username: str
    password: bytes | None = None   # encrypted
    ssh_key: bytes | None = None    # encrypted
    use_cert: bool = False


def spec_from(gw) -> GatewaySpec:
    cred = gw.credential
    from app.models.base import CredentialType
    use_cert = gw.use_cert or (cred is not None and cred.type == CredentialType.EPHEMERAL_CERT)
    return GatewaySpec(
        id=str(gw.id), name=gw.name, host=gw.host, port=gw.port, username=gw.username,
        password=None if use_cert or cred is None else cred.encrypted_password,
        ssh_key=None if use_cert or cred is None else cred.encrypted_ssh_key,
        use_cert=use_cert,
    )


async def connect_gateway(spec: GatewaySpec, timeout: float = 10) -> asyncssh.SSHClientConnection:
    kwargs: dict = {"host": spec.host, "port": spec.port, "username": spec.username, "known_hosts": None}
    key_path = None
    if spec.use_cert:
        from app.services.ca_service import sign_user_certificate
        key_path, _ = sign_user_certificate(username=spec.username, validity_minutes=60)
        kwargs["client_keys"] = [key_path]
    elif spec.ssh_key:
        kwargs["client_keys"] = [asyncssh.import_private_key(decrypt_value(spec.ssh_key))]
    elif spec.password:
        kwargs["password"] = decrypt_value(spec.password)
    else:
        raise ValueError(f"Gateway {spec.name} has no credential")
    try:
        return await asyncio.wait_for(asyncssh.connect(**kwargs), timeout=timeout)
    finally:
        if key_path:
            from app.services.ca_service import cleanup_cert_files
            cleanup_cert_files(key_path)


@dataclass
class _RouteState:
    gateways: list[GatewaySpec]
    conn: asyncssh.SSHClientConnection | None = None
    used: GatewaySpec | None = None
    listeners: list = field(default_factory=list)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def connection(self) -> asyncssh.SSHClientConnection:
        async with self.lock:
            if self.conn is not None:
                return self.conn
            errors = []
            for gw in self.gateways:
                try:
                    self.conn = await connect_gateway(gw)
                    self.used = gw
                    logger.info("route via gateway %s (%s:%d)", gw.name, gw.host, gw.port)
                    return self.conn
                except Exception as e:  # noqa: BLE001 - try the next gateway
                    errors.append(f"{gw.name}: {type(e).__name__}: {e}")
            raise ConnectionError("No gateway reachable: " + "; ".join(errors))

    async def close(self) -> None:
        for lst in self.listeners:
            lst.close()
        self.listeners.clear()
        if self.conn is not None:
            self.conn.close()
            self.conn = None


_routes: contextvars.ContextVar[dict[str, _RouteState]] = contextvars.ContextVar("citadel_routes", default={})


def gateways_of(server) -> list[GatewaySpec]:
    zone = getattr(server, "zone", None)
    if zone is None:
        return []
    return [spec_from(g) for g in sorted(zone.gateways, key=lambda g: g.priority) if g.is_active]


@asynccontextmanager
async def via(server):
    """Route connections to `server` through its zone's gateways for the block's duration."""
    gws = gateways_of(server)
    if not gws:
        yield None
        return
    state = _RouteState(gws)
    token = _routes.set({**_routes.get(), server.ip_address: state})
    try:
        yield state
    finally:
        _routes.reset(token)
        await state.close()


def _state(host: str) -> _RouteState | None:
    return _routes.get().get(host)


async def tunnel_for(host: str) -> asyncssh.SSHClientConnection | None:
    """Gateway connection to use as asyncssh `tunnel=` for this host, or None (direct)."""
    state = _state(host)
    return await state.connection() if state else None


async def tcp_endpoint(host: str, port: int, for_other_container: bool = False) -> tuple[str, int]:
    """Address to reach host:port. Through a gateway: a local port forward.

    for_other_container: bind on all interfaces and return the backend's internal
    hostname (guacd connects from its own container).
    """
    state = _state(host)
    if state is None:
        return host, port
    conn = await state.connection()
    listener = await conn.forward_local_port("0.0.0.0" if for_other_container else "127.0.0.1", 0, host, port)
    state.listeners.append(listener)
    return (BACKEND_INTERNAL_HOST if for_other_container else "127.0.0.1"), listener.get_port()


async def check_gateway(gw) -> tuple[bool, str]:
    """Connect to a gateway and run a trivial command; updates its health fields."""
    spec = spec_from(gw)
    try:
        conn = await connect_gateway(spec)
        try:
            res = await asyncio.wait_for(conn.run("echo citadel-gateway-ok", check=False), timeout=10)
            ok = "citadel-gateway-ok" in (res.stdout or "")
            msg = "Passerelle joignable" if ok else f"Réponse inattendue: {(res.stderr or res.stdout or '')[:200]}"
        finally:
            conn.close()
    except Exception as e:  # noqa: BLE001
        ok, msg = False, f"{type(e).__name__}: {e}"[:500]
    gw.last_check_at = datetime.now(timezone.utc)
    gw.last_check_ok = ok
    gw.last_check_message = msg
    return ok, msg
