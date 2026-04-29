"""Update detection and application for Linux and Windows servers."""

import json
import re
from dataclasses import dataclass, field

from app.services import ssh_service, winrm_service


@dataclass
class PackageUpdate:
    name: str
    current_version: str
    new_version: str
    severity: str = "unknown"  # critical, important, moderate, low, unknown
    size: str = ""


@dataclass
class UpdateScanResult:
    server_id: str
    os_type: str
    package_manager: str
    total_updates: int
    security_updates: int
    packages: list[PackageUpdate] = field(default_factory=list)
    error: str | None = None


@dataclass
class UpdateApplyResult:
    success: bool
    packages_updated: int
    output: str
    error: str | None = None


# ── Linux: detect package manager ────────────────────────


async def _detect_linux_pm(
    host: str, port: int, username: str,
    password: bytes | None, ssh_key: bytes | None,
) -> str:
    """Detect which package manager is available."""
    result = await ssh_service.execute_command(
        host, port, username,
        "which apt 2>/dev/null && echo APT || (which dnf 2>/dev/null && echo DNF || (which yum 2>/dev/null && echo YUM || echo UNKNOWN))",
        password=password, ssh_key=ssh_key, timeout=10,
    )
    output = result.stdout.strip().split("\n")[-1].strip()
    if "APT" in output:
        return "apt"
    elif "DNF" in output:
        return "dnf"
    elif "YUM" in output:
        return "yum"
    return "unknown"


# ── Linux: APT ───────────────────────────────────────────


async def _scan_apt(
    host: str, port: int, username: str,
    password: bytes | None, ssh_key: bytes | None,
) -> list[PackageUpdate]:
    """Scan for available updates using apt."""
    # Update package lists
    await ssh_service.execute_command(
        host, port, username, "sudo apt-get update -qq 2>/dev/null",
        password=password, ssh_key=ssh_key, timeout=60,
    )

    # List upgradable packages
    result = await ssh_service.execute_command(
        host, port, username,
        "apt list --upgradable 2>/dev/null | grep -v '^Listing'",
        password=password, ssh_key=ssh_key, timeout=30,
    )

    packages = []
    for line in result.stdout.strip().split("\n"):
        if not line.strip():
            continue
        # Format: package/source new_version arch [upgradable from: current_version]
        match = re.match(
            r"^(\S+?)\/\S+\s+(\S+)\s+\S+\s+\[upgradable from:\s+(\S+)\]",
            line,
        )
        if match:
            packages.append(PackageUpdate(
                name=match.group(1),
                new_version=match.group(2),
                current_version=match.group(3),
            ))

    # Check security updates
    sec_result = await ssh_service.execute_command(
        host, port, username,
        "apt list --upgradable 2>/dev/null | grep -i secur | wc -l",
        password=password, ssh_key=ssh_key, timeout=15,
    )
    sec_count = int(sec_result.stdout.strip() or "0")

    # Mark first N as security if we got a count
    for i, pkg in enumerate(packages):
        if i < sec_count:
            pkg.severity = "critical"

    return packages


# ── Linux: DNF / YUM ─────────────────────────────────────


async def _scan_dnf_yum(
    host: str, port: int, username: str,
    password: bytes | None, ssh_key: bytes | None,
    pm: str,
) -> list[PackageUpdate]:
    """Scan for available updates using dnf or yum."""
    result = await ssh_service.execute_command(
        host, port, username,
        f"sudo {pm} check-update 2>/dev/null || true",
        password=password, ssh_key=ssh_key, timeout=120,
    )

    packages = []
    in_packages = False
    for line in result.stdout.split("\n"):
        line = line.strip()
        if not line:
            in_packages = True
            continue
        if not in_packages:
            continue
        # Format: package_name.arch   new_version   repo
        parts = line.split()
        if len(parts) >= 2:
            name = parts[0].rsplit(".", 1)[0]  # Remove .arch
            new_version = parts[1]
            packages.append(PackageUpdate(
                name=name,
                new_version=new_version,
                current_version="installed",
            ))

    # Security updates
    sec_result = await ssh_service.execute_command(
        host, port, username,
        f"sudo {pm} updateinfo list security 2>/dev/null | wc -l",
        password=password, ssh_key=ssh_key, timeout=30,
    )
    sec_count = int(sec_result.stdout.strip() or "0")
    for i, pkg in enumerate(packages):
        if i < sec_count:
            pkg.severity = "critical"

    return packages


# ── Linux: public API ────────────────────────────────────


async def scan_linux_updates(
    server_id: str, host: str, port: int, username: str,
    password: bytes | None = None, ssh_key: bytes | None = None,
) -> UpdateScanResult:
    """Scan a Linux server for available updates."""
    try:
        pm = await _detect_linux_pm(host, port, username, password, ssh_key)

        if pm == "apt":
            packages = await _scan_apt(host, port, username, password, ssh_key)
        elif pm in ("dnf", "yum"):
            packages = await _scan_dnf_yum(host, port, username, password, ssh_key, pm)
        else:
            return UpdateScanResult(
                server_id=server_id, os_type="linux", package_manager="unknown",
                total_updates=0, security_updates=0,
                error="No supported package manager found (apt/dnf/yum)",
            )

        sec_count = sum(1 for p in packages if p.severity == "critical")
        return UpdateScanResult(
            server_id=server_id, os_type="linux", package_manager=pm,
            total_updates=len(packages), security_updates=sec_count,
            packages=packages,
        )
    except Exception as e:
        return UpdateScanResult(
            server_id=server_id, os_type="linux", package_manager="unknown",
            total_updates=0, security_updates=0, error=str(e),
        )


async def apply_linux_updates(
    host: str, port: int, username: str,
    password: bytes | None = None, ssh_key: bytes | None = None,
    packages: list[str] | None = None,
) -> UpdateApplyResult:
    """Apply updates on a Linux server."""
    try:
        pm = await _detect_linux_pm(host, port, username, password, ssh_key)

        if pm == "apt":
            if packages:
                cmd = f"sudo DEBIAN_FRONTEND=noninteractive apt-get install -y {' '.join(packages)} 2>&1"
            else:
                cmd = "sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y 2>&1"
        elif pm in ("dnf", "yum"):
            if packages:
                cmd = f"sudo {pm} update -y {' '.join(packages)} 2>&1"
            else:
                cmd = f"sudo {pm} update -y 2>&1"
        else:
            return UpdateApplyResult(success=False, packages_updated=0, output="", error="Unsupported PM")

        result = await ssh_service.execute_command(
            host, port, username, cmd,
            password=password, ssh_key=ssh_key, timeout=600,
        )

        success = result.exit_code == 0
        return UpdateApplyResult(
            success=success,
            packages_updated=len(packages) if packages else -1,
            output=result.stdout[-2000:],  # Truncate to last 2000 chars
            error=result.stderr[-500:] if result.stderr else None,
        )
    except Exception as e:
        return UpdateApplyResult(success=False, packages_updated=0, output="", error=str(e))


# ── Windows ──────────────────────────────────────────────


async def scan_windows_updates(
    server_id: str, host: str, port: int, username: str,
    password: bytes | None = None, ssh_key: bytes | None = None,
) -> UpdateScanResult:
    """Scan a Windows server for available updates via PowerShell."""
    script = """
try {
    $Session = New-Object -ComObject Microsoft.Update.Session
    $Searcher = $Session.CreateUpdateSearcher()
    $Results = $Searcher.Search("IsInstalled=0")

    $updates = @()
    foreach ($Update in $Results.Updates) {
        $severity = "unknown"
        if ($Update.MsrcSeverity) { $severity = $Update.MsrcSeverity.ToLower() }

        $updates += @{
            name = $Update.Title
            current_version = "installed"
            new_version = if ($Update.Identity.UpdateID) { $Update.Identity.UpdateID.Substring(0,8) } else { "N/A" }
            severity = $severity
            size = [math]::Round($Update.MaxDownloadSize / 1MB, 1).ToString() + " MB"
        }
    }

    @{
        total = $Results.Updates.Count
        security = ($Results.Updates | Where-Object { $_.MsrcSeverity -eq "Critical" -or $_.MsrcSeverity -eq "Important" }).Count
        packages = $updates
    } | ConvertTo-Json -Depth 3
} catch {
    @{ error = $_.Exception.Message } | ConvertTo-Json
}
"""
    try:
        result = await winrm_service.execute_command(
            host, port, username, script,
            password=password, ssh_key=ssh_key, timeout=120,
        )

        data = json.loads(result.stdout)

        if "error" in data:
            return UpdateScanResult(
                server_id=server_id, os_type="windows", package_manager="windows_update",
                total_updates=0, security_updates=0, error=data["error"],
            )

        packages = [
            PackageUpdate(
                name=p["name"],
                current_version=p["current_version"],
                new_version=p["new_version"],
                severity=p.get("severity", "unknown"),
                size=p.get("size", ""),
            )
            for p in data.get("packages", [])
        ]

        return UpdateScanResult(
            server_id=server_id, os_type="windows", package_manager="windows_update",
            total_updates=data.get("total", 0),
            security_updates=data.get("security", 0),
            packages=packages,
        )
    except Exception as e:
        return UpdateScanResult(
            server_id=server_id, os_type="windows", package_manager="windows_update",
            total_updates=0, security_updates=0, error=str(e),
        )


async def apply_windows_updates(
    host: str, port: int, username: str,
    password: bytes | None = None, ssh_key: bytes | None = None,
    packages: list[str] | None = None,
) -> UpdateApplyResult:
    """Apply Windows updates via PowerShell."""
    script = """
try {
    $Session = New-Object -ComObject Microsoft.Update.Session
    $Searcher = $Session.CreateUpdateSearcher()
    $Results = $Searcher.Search("IsInstalled=0")

    $ToInstall = New-Object -ComObject Microsoft.Update.UpdateColl
    foreach ($Update in $Results.Updates) {
        $Update.AcceptEula()
        $ToInstall.Add($Update) | Out-Null
    }

    if ($ToInstall.Count -eq 0) {
        @{ success = $true; count = 0; output = "No updates to install" } | ConvertTo-Json
        return
    }

    $Downloader = $Session.CreateUpdateDownloader()
    $Downloader.Updates = $ToInstall
    $Downloader.Download() | Out-Null

    $Installer = $Session.CreateUpdateInstaller()
    $Installer.Updates = $ToInstall
    $InstallResult = $Installer.Install()

    @{
        success = ($InstallResult.ResultCode -eq 2)
        count = $ToInstall.Count
        output = "Installed $($ToInstall.Count) updates. Reboot required: $($InstallResult.RebootRequired)"
    } | ConvertTo-Json
} catch {
    @{ success = $false; count = 0; output = $_.Exception.Message } | ConvertTo-Json
}
"""
    try:
        result = await winrm_service.execute_command(
            host, port, username, script,
            password=password, ssh_key=ssh_key, timeout=600,
        )

        data = json.loads(result.stdout)
        return UpdateApplyResult(
            success=data.get("success", False),
            packages_updated=data.get("count", 0),
            output=data.get("output", ""),
        )
    except Exception as e:
        return UpdateApplyResult(success=False, packages_updated=0, output="", error=str(e))
