import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.server import Server
from app.models.credential import Credential
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


async def _get_server_with_credential(
    server_id: str, db: AsyncSession
) -> tuple[Server, Credential | None]:
    """Fetch server and its associated credential."""
    result = await db.execute(select(Server).where(Server.id == server_id))
    server = result.scalar_one_or_none()
    if not server:
        raise ValueError(f"Server {server_id} not found")

    credential = None
    if server.credential_id:
        cred_result = await db.execute(
            select(Credential).where(Credential.id == server.credential_id)
        )
        credential = cred_result.scalar_one_or_none()

    return server, credential


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


async def test_connection(
    server_id: str, db: AsyncSession
) -> ConnectionTestResult:
    """Test connectivity to a server and update its status."""
    server, credential = await _get_server_with_credential(server_id, db)

    if not credential:
        return ConnectionTestResult(
            server_id=str(server.id),
            server_name=server.name,
            success=False,
            message="No credential assigned to this server",
        )

    service = _get_service(server)
    port = _get_port(server)

    start = asyncio.get_event_loop().time()
    success, message = await service.test_connection(
        host=server.ip_address,
        port=port,
        username=credential.username,
        password=credential.encrypted_password,
        ssh_key=credential.encrypted_ssh_key,
    )
    elapsed = (asyncio.get_event_loop().time() - start) * 1000

    # Update server status in DB
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
    server_id: str, command: str, db: AsyncSession, timeout: int = 30
) -> CommandResult:
    """Execute a command on a remote server."""
    server, credential = await _get_server_with_credential(server_id, db)

    if not credential:
        raise ValueError("No credential assigned to this server")

    service = _get_service(server)
    port = _get_port(server)

    result = await service.execute_command(
        host=server.ip_address,
        port=port,
        username=credential.username,
        command=command,
        password=credential.encrypted_password,
        ssh_key=credential.encrypted_ssh_key,
        timeout=timeout,
    )

    return CommandResult(
        exit_code=result.exit_code,
        stdout=result.stdout,
        stderr=result.stderr,
    )


async def get_system_info(
    server_id: str, db: AsyncSession
) -> SystemInfo:
    """Get system information from a remote server."""
    server, credential = await _get_server_with_credential(server_id, db)

    if not credential:
        raise ValueError("No credential assigned to this server")

    service = _get_service(server)
    port = _get_port(server)

    info = await service.get_system_info(
        host=server.ip_address,
        port=port,
        username=credential.username,
        password=credential.encrypted_password,
        ssh_key=credential.encrypted_ssh_key,
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
