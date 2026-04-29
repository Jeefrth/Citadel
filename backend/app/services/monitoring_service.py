"""Real-time metrics collection from Linux and Windows servers."""

import json
from dataclasses import dataclass

from app.services import ssh_service, winrm_service


@dataclass
class ServerMetrics:
    cpu_percent: float
    cpu_count: int
    load_average: str
    memory_total_mb: int
    memory_used_mb: int
    memory_percent: float
    disk_total_gb: float
    disk_used_gb: float
    disk_percent: float
    network_rx_bytes: int
    network_tx_bytes: int
    uptime_seconds: int
    process_count: int


# ── Linux ────────────────────────────────────────────────


_LINUX_METRICS_SCRIPT = r"""
cpu_idle=$(top -bn1 | grep '%Cpu' | awk '{print $8}' | head -1)
cpu_percent=$(echo "100 - ${cpu_idle:-0}" | bc 2>/dev/null || echo "0")
cpu_count=$(nproc)
load_avg=$(cat /proc/loadavg | awk '{print $1", "$2", "$3}')

mem_total=$(free -m | awk '/^Mem:/{print $2}')
mem_used=$(free -m | awk '/^Mem:/{print $3}')
mem_percent=$(echo "scale=1; $mem_used * 100 / $mem_total" | bc 2>/dev/null || echo "0")

disk_total=$(df -BG / | awk 'NR==2{gsub("G",""); print $2}')
disk_used=$(df -BG / | awk 'NR==2{gsub("G",""); print $3}')
disk_percent=$(df / | awk 'NR==2{gsub("%",""); print $5}')

rx_bytes=$(cat /proc/net/dev | grep -v lo | awk 'NR>2{sum+=$2} END{print sum+0}')
tx_bytes=$(cat /proc/net/dev | grep -v lo | awk 'NR>2{sum+=$10} END{print sum+0}')

uptime_sec=$(awk '{print int($1)}' /proc/uptime)
proc_count=$(ps aux --no-heading | wc -l)

echo "{\"cpu_percent\":${cpu_percent:-0},\"cpu_count\":${cpu_count:-1},\"load_average\":\"${load_avg}\",\"memory_total_mb\":${mem_total:-0},\"memory_used_mb\":${mem_used:-0},\"memory_percent\":${mem_percent:-0},\"disk_total_gb\":${disk_total:-0},\"disk_used_gb\":${disk_used:-0},\"disk_percent\":${disk_percent:-0},\"network_rx_bytes\":${rx_bytes:-0},\"network_tx_bytes\":${tx_bytes:-0},\"uptime_seconds\":${uptime_sec:-0},\"process_count\":${proc_count:-0}}"
"""


async def collect_linux_metrics(
    host: str, port: int, username: str,
    password: bytes | None = None, ssh_key: bytes | None = None,
) -> ServerMetrics:
    """Collect real-time metrics from a Linux server."""
    result = await ssh_service.execute_command(
        host, port, username, _LINUX_METRICS_SCRIPT,
        password=password, ssh_key=ssh_key, timeout=15,
    )

    if result.exit_code != 0:
        raise RuntimeError(f"Metrics collection failed: {result.stderr}")

    data = json.loads(result.stdout.strip())
    return ServerMetrics(**data)


# ── Windows ──────────────────────────────────────────────


_WINDOWS_METRICS_SCRIPT = r"""
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$cpuCount = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$os = Get-CimInstance Win32_OperatingSystem
$memTotal = [math]::Round($os.TotalVisibleMemorySize / 1024)
$memFree = [math]::Round($os.FreePhysicalMemory / 1024)
$memUsed = $memTotal - $memFree
$memPercent = [math]::Round($memUsed / $memTotal * 100, 1)

$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$diskTotal = [math]::Round($disk.Size / 1GB, 1)
$diskUsed = [math]::Round(($disk.Size - $disk.FreeSpace) / 1GB, 1)
$diskPercent = [math]::Round(($disk.Size - $disk.FreeSpace) / $disk.Size * 100, 0)

$net = Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface | Where-Object { $_.Name -notlike '*Loopback*' } | Select-Object -First 1
$rxBytes = if ($net) { $net.BytesReceivedPersec } else { 0 }
$txBytes = if ($net) { $net.BytesSentPersec } else { 0 }

$uptime = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalSeconds)
$procCount = (Get-Process).Count

@{
    cpu_percent = $cpu
    cpu_count = $cpuCount
    load_average = "$cpu%"
    memory_total_mb = $memTotal
    memory_used_mb = $memUsed
    memory_percent = $memPercent
    disk_total_gb = $diskTotal
    disk_used_gb = $diskUsed
    disk_percent = $diskPercent
    network_rx_bytes = $rxBytes
    network_tx_bytes = $txBytes
    uptime_seconds = $uptime
    process_count = $procCount
} | ConvertTo-Json
"""


async def collect_windows_metrics(
    host: str, port: int, username: str,
    password: bytes | None = None, ssh_key: bytes | None = None,
) -> ServerMetrics:
    """Collect real-time metrics from a Windows server."""
    result = await winrm_service.execute_command(
        host, port, username, _WINDOWS_METRICS_SCRIPT,
        password=password, ssh_key=ssh_key, timeout=20,
    )

    if result.exit_code != 0:
        raise RuntimeError(f"Metrics collection failed: {result.stderr}")

    data = json.loads(result.stdout.strip())
    return ServerMetrics(**data)
