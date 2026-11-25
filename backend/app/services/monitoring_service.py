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
# /proc + awk only: no bc / top / free / ps (often missing on minimal servers)
read_cpu() { awk '/^cpu /{idle=$5+$6; t=0; for(i=2;i<=NF;i++) t+=$i; print t, idle}' /proc/stat; }
set -- $(read_cpu); t1=$1; i1=$2
sleep 0.5
set -- $(read_cpu); t2=$1; i2=$2
cpu_percent=$(awk -v t="$((t2 - t1))" -v i="$((i2 - i1))" 'BEGIN{ if (t > 0) printf "%.1f", (t - i) * 100 / t; else print 0 }')
cpu_count=$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo)
load_avg=$(awk '{print $1", "$2", "$3}' /proc/loadavg)

mem_total=$(awk '/^MemTotal:/{printf "%d", $2/1024}' /proc/meminfo)
mem_avail=$(awk '/^MemAvailable:/{printf "%d", $2/1024}' /proc/meminfo)
mem_used=$(( ${mem_total:-0} - ${mem_avail:-0} ))
mem_percent=$(awk -v u="$mem_used" -v t="${mem_total:-0}" 'BEGIN{ if (t > 0) printf "%.1f", u * 100 / t; else print 0 }')

disk_total=$(df -P -k / | awk 'NR==2{printf "%.1f", $2/1048576}')
disk_used=$(df -P -k / | awk 'NR==2{printf "%.1f", $3/1048576}')
disk_percent=$(df -P / | awk 'NR==2{gsub("%",""); print $5}')

rx_bytes=$(awk -F'[: ]+' 'NR>2 && $2!="lo"{sum+=$3} END{print sum+0}' /proc/net/dev)
tx_bytes=$(awk -F'[: ]+' 'NR>2 && $2!="lo"{sum+=$11} END{print sum+0}' /proc/net/dev)

uptime_sec=$(awk '{print int($1)}' /proc/uptime)
proc_count=$(ls -d /proc/[0-9]* 2>/dev/null | wc -l)

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
