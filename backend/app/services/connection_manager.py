import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.permissions import ResolvedAccount
from app.models.server import Server
from app.models.base import OSType, ServerStatus
from app.services import ssh_service, winrm_service


@dataclass
class ConnectionTestResult:
    server_id: str
    server_name: str
    success: bool
    message: str
    latency_ms: float | None = None


@dataclass
class CommandResult:
    exit_code: int
    stdout: str
    stderr: str


@dataclass
class SystemInfo:
    hostname: str
    os: str
    kernel: str
    uptime: str
    cpu_count: str
    memory_total: str
    memory_used: str
    disk_usage: str


def _get_service(server: Server):
    """Return the appropriate service module based on server OS type."""
    if server.os_type == OSType.LINUX:
        return ssh_service
    elif server.os_type == OSType.WINDOWS:
        return winrm_service
    else:
        raise ValueError(f"Unsupported OS type: {server.os_type}")


def _get_port(server: Server) -> int:
    """Return the connection port based on OS type."""
    if server.os_type == OSType.LINUX:
        return server.ssh_port
    return server.winrm_port


def _auth_kwargs(server: Server, account: ResolvedAccount) -> dict:
    """Service kwargs for an account. One-shot operations use 1-minute certs."""
    if account.use_cert:
        if server.os_type != OSType.LINUX:
            raise ValueError("Ephemeral certificates are only supported on Linux (SSH)")
        return {"use_ephemeral_cert": True, "cert_validity_minutes": 1}
    if server.os_type == OSType.WINDOWS:
        return {"password": account.password}
    return {"password": account.password, "ssh_key": account.ssh_key}


async def test_connection(
    server: Server, account: ResolvedAccount | None, db: AsyncSession
) -> ConnectionTestResult:
    """Test connectivity to a server with its default account and update its status."""
    if account is None:
        return ConnectionTestResult(
            server_id=str(server.id),
            server_name=server.name,
            success=False,
            message="No default account configured",
        )

    try:
        auth_kwargs = _auth_kwargs(server, account)
    except ValueError as e:
        return ConnectionTestResult(
            server_id=str(server.id), server_name=server.name, success=False, message=str(e),
        )

    service = _get_service(server)
    port = _get_port(server)

    start = asyncio.get_event_loop().time()
    success, message = await service.test_connection(
        host=server.ip_address,
        port=port,
        username=account.username,
        **auth_kwargs,
    )
    elapsed = (asyncio.get_event_loop().time() - start) * 1000

    server.status = ServerStatus.ONLINE if success else ServerStatus.OFFLINE
    if success:
        server.last_seen = datetime.now(timezone.utc)
    await db.commit()

    return ConnectionTestResult(
        server_id=str(server.id),
        server_name=server.name,
        success=success,
        message=message,
        latency_ms=round(elapsed, 1),
    )


async def execute_command(
    server: Server, account: ResolvedAccount, command: str, timeout: int = 30
) -> CommandResult:
    """Execute a command on a remote server with the given account."""
    result = await _get_service(server).execute_command(
        host=server.ip_address,
        port=_get_port(server),
        username=account.username,
        command=command,
        timeout=timeout,
        **_auth_kwargs(server, account),
    )
    return CommandResult(exit_code=result.exit_code, stdout=result.stdout, stderr=result.stderr)


async def get_system_info(server: Server, account: ResolvedAccount) -> SystemInfo:
    """Get system information from a remote server."""
    info = await _get_service(server).get_system_info(
        host=server.ip_address,
        port=_get_port(server),
        username=account.username,
        **_auth_kwargs(server, account),
    )
    return SystemInfo(
        hostname=info.hostname,
        os=info.os,
        kernel=info.kernel,
        uptime=info.uptime,
        cpu_count=info.cpu_count,
        memory_total=info.memory_total,
        memory_used=info.memory_used,
        disk_usage=info.disk_usage,
    )
