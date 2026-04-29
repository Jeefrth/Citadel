import asyncio
from dataclasses import dataclass

import asyncssh

from app.core.security import decrypt_value


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


async def _connect(
    host: str,
    port: int,
    username: str,
    password: bytes | None = None,
    ssh_key: bytes | None = None,
) -> asyncssh.SSHClientConnection:
    """Open an SSH connection to a Linux server."""
    connect_kwargs: dict = {
        "host": host,
        "port": port,
        "username": username,
        "known_hosts": None,  # TODO: implement known_hosts verification for production
    }

    if ssh_key:
        key_str = decrypt_value(ssh_key)
        connect_kwargs["client_keys"] = [asyncssh.import_private_key(key_str)]
    elif password:
        connect_kwargs["password"] = decrypt_value(password)
    else:
        raise ValueError("No password or SSH key provided")

    return await asyncio.wait_for(
        asyncssh.connect(**connect_kwargs),
        timeout=10,
    )


async def test_connection(
    host: str,
    port: int,
    username: str,
    password: bytes | None = None,
    ssh_key: bytes | None = None,
) -> tuple[bool, str]:
    """Test SSH connectivity. Returns (success, message)."""
    try:
        conn = await _connect(host, port, username, password, ssh_key)
        result = await conn.run("echo ok", timeout=5)
        conn.close()
        if result.stdout.strip() == "ok":
            return True, f"SSH connection successful to {host}:{port}"
        return False, f"Unexpected response: {result.stdout}"
    except asyncio.TimeoutError:
        return False, f"Connection timed out to {host}:{port}"
    except asyncssh.PermissionDenied:
        return False, f"Authentication failed for {username}@{host}:{port}"
    except OSError as e:
        return False, f"Connection refused: {e}"
    except Exception as e:
        return False, f"SSH error: {type(e).__name__}: {e}"


async def execute_command(
    host: str,
    port: int,
    username: str,
    command: str,
    password: bytes | None = None,
    ssh_key: bytes | None = None,
    timeout: int = 30,
) -> CommandResult:
    """Execute a command over SSH and return the result."""
    conn = await _connect(host, port, username, password, ssh_key)
    try:
        result = await conn.run(command, timeout=timeout)
        return CommandResult(
            exit_code=result.exit_status or 0,
            stdout=result.stdout or "",
            stderr=result.stderr or "",
        )
    finally:
        conn.close()


async def get_system_info(
    host: str,
    port: int,
    username: str,
    password: bytes | None = None,
    ssh_key: bytes | None = None,
) -> SystemInfo:
    """Gather system information from a Linux server."""
    commands = {
        "hostname": "hostname",
        "os": "cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'\"' -f2 || uname -o",
        "kernel": "uname -r",
        "uptime": "uptime -p 2>/dev/null || uptime",
        "cpu_count": "nproc",
        "memory_total": "free -h | awk '/^Mem:/{print $2}'",
        "memory_used": "free -h | awk '/^Mem:/{print $3}'",
        "disk_usage": "df -h / | awk 'NR==2{print $3\"/\"$2\" (\"$5\")\"}'",
    }

    conn = await _connect(host, port, username, password, ssh_key)
    results = {}
    try:
        for key, cmd in commands.items():
            result = await conn.run(cmd, timeout=10)
            results[key] = (result.stdout or "").strip()
    finally:
        conn.close()

    return SystemInfo(**results)
