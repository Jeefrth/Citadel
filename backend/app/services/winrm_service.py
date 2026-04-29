import asyncio
from dataclasses import dataclass
from functools import partial

import winrm

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


def _create_session(
    host: str,
    port: int,
    username: str,
    password: bytes | None = None,
) -> winrm.Session:
    """Create a WinRM session to a Windows server."""
    if not password:
        raise ValueError("WinRM requires a password")

    decrypted_pwd = decrypt_value(password)
    endpoint = f"http://{host}:{port}/wsman"

    return winrm.Session(
        endpoint,
        auth=(username, decrypted_pwd),
        transport="ntlm",
        server_cert_validation="ignore",
    )


def _run_ps_sync(session: winrm.Session, script: str) -> CommandResult:
    """Run a PowerShell command synchronously (used in thread pool)."""
    result = session.run_ps(script)
    return CommandResult(
        exit_code=result.status_code,
        stdout=result.std_out.decode("utf-8", errors="replace"),
        stderr=result.std_err.decode("utf-8", errors="replace"),
    )


async def test_connection(
    host: str,
    port: int,
    username: str,
    password: bytes | None = None,
    ssh_key: bytes | None = None,
) -> tuple[bool, str]:
    """Test WinRM connectivity. Returns (success, message)."""
    try:
        session = _create_session(host, port, username, password)
        loop = asyncio.get_event_loop()
        result = await asyncio.wait_for(
            loop.run_in_executor(
                None, partial(_run_ps_sync, session, "Write-Output 'ok'")
            ),
            timeout=15,
        )
        if "ok" in result.stdout:
            return True, f"WinRM connection successful to {host}:{port}"
        return False, f"Unexpected response: {result.stdout}"
    except asyncio.TimeoutError:
        return False, f"Connection timed out to {host}:{port}"
    except Exception as e:
        return False, f"WinRM error: {type(e).__name__}: {e}"


async def execute_command(
    host: str,
    port: int,
    username: str,
    command: str,
    password: bytes | None = None,
    ssh_key: bytes | None = None,
    timeout: int = 30,
) -> CommandResult:
    """Execute a PowerShell command over WinRM and return the result."""
    session = _create_session(host, port, username, password)
    loop = asyncio.get_event_loop()
    return await asyncio.wait_for(
        loop.run_in_executor(None, partial(_run_ps_sync, session, command)),
        timeout=timeout,
    )


async def get_system_info(
    host: str,
    port: int,
    username: str,
    password: bytes | None = None,
    ssh_key: bytes | None = None,
) -> SystemInfo:
    """Gather system information from a Windows server."""
    script = """
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"

$info = @{
    hostname = $env:COMPUTERNAME
    os = $os.Caption + " " + $os.Version
    kernel = $os.BuildNumber
    uptime = ((Get-Date) - $os.LastBootUpTime).ToString("d' days 'h'h 'mm'min'")
    cpu_count = $cs.NumberOfLogicalProcessors.ToString()
    memory_total = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1).ToString() + " GB"
    memory_used = [math]::Round(($cs.TotalPhysicalMemory - $os.FreePhysicalMemory * 1KB) / 1GB, 1).ToString() + " GB"
    disk_usage = [math]::Round(($disk.Size - $disk.FreeSpace) / 1GB, 1).ToString() + "/" + [math]::Round($disk.Size / 1GB, 1).ToString() + " GB (" + [math]::Round(($disk.Size - $disk.FreeSpace) / $disk.Size * 100, 0).ToString() + "%)"
}
$info | ConvertTo-Json
"""
    session = _create_session(host, port, username, password)
    loop = asyncio.get_event_loop()
    result = await asyncio.wait_for(
        loop.run_in_executor(None, partial(_run_ps_sync, session, script)),
        timeout=20,
    )

    if result.exit_code != 0:
        raise RuntimeError(f"Failed to get system info: {result.stderr}")

    import json
    data = json.loads(result.stdout)
    return SystemInfo(**data)
