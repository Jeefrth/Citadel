import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select, func, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user, require_role
from app.core.database import get_db
from app.models.user import User
from app.models.server import Server
from app.models.credential import Credential
from app.models.metric import ServerMetric, AlertRule
from app.models.base import UserRole, OSType, ServerStatus
from app.schemas.monitoring import (
    MetricsRead,
    MetricsHistoryPoint,
    ServerSummary,
    DashboardSummary,
    AlertRuleCreate,
    AlertRuleRead,
    ActiveAlert,
)
from app.services import monitoring_service

router = APIRouter()


# ── Metrics collection ───────────────────────────────────


@router.post("/{server_id}/metrics", response_model=MetricsRead)
async def collect_metrics(
    server_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Collect real-time metrics from a server and store in history."""
    result = await db.execute(select(Server).where(Server.id == server_id))
    server = result.scalar_one_or_none()
    if not server:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Server not found")

    if not server.credential_id:
        raise HTTPException(status_code=400, detail="No credential assigned")

    cred_result = await db.execute(
        select(Credential).where(Credential.id == server.credential_id)
    )
    credential = cred_result.scalar_one_or_none()
    if not credential:
        raise HTTPException(status_code=400, detail="Credential not found")

    port = server.ssh_port if server.os_type == OSType.LINUX else server.winrm_port

    try:
        if server.os_type == OSType.LINUX:
            metrics = await monitoring_service.collect_linux_metrics(
                host=server.ip_address, port=port,
                username=credential.username,
                password=credential.encrypted_password,
                ssh_key=credential.encrypted_ssh_key,
            )
        else:
            metrics = await monitoring_service.collect_windows_metrics(
                host=server.ip_address, port=port,
                username=credential.username,
                password=credential.encrypted_password,
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Metrics collection failed: {e}")

    # Store in DB
    db_metric = ServerMetric(
        server_id=server.id,
        cpu_percent=metrics.cpu_percent,
        cpu_count=metrics.cpu_count,
        load_average=metrics.load_average,
        memory_total_mb=metrics.memory_total_mb,
        memory_used_mb=metrics.memory_used_mb,
        memory_percent=metrics.memory_percent,
        disk_total_gb=metrics.disk_total_gb,
        disk_used_gb=metrics.disk_used_gb,
        disk_percent=metrics.disk_percent,
        network_rx_bytes=metrics.network_rx_bytes,
        network_tx_bytes=metrics.network_tx_bytes,
        uptime_seconds=metrics.uptime_seconds,
        process_count=metrics.process_count,
    )
    db.add(db_metric)

    # Update server status
    server.status = ServerStatus.ONLINE
    server.last_seen = datetime.now(timezone.utc)

    await db.commit()

    return MetricsRead(
        cpu_percent=metrics.cpu_percent,
        cpu_count=metrics.cpu_count,
        load_average=metrics.load_average,
        memory_total_mb=metrics.memory_total_mb,
        memory_used_mb=metrics.memory_used_mb,
        memory_percent=metrics.memory_percent,
        disk_total_gb=metrics.disk_total_gb,
        disk_used_gb=metrics.disk_used_gb,
        disk_percent=metrics.disk_percent,
        network_rx_bytes=metrics.network_rx_bytes,
        network_tx_bytes=metrics.network_tx_bytes,
        uptime_seconds=metrics.uptime_seconds,
        process_count=metrics.process_count,
    )


@router.get("/{server_id}/metrics/latest", response_model=MetricsRead | None)
async def get_latest_metrics(
    server_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get the most recent metrics for a server."""
    result = await db.execute(
        select(ServerMetric)
        .where(ServerMetric.server_id == server_id)
        .order_by(ServerMetric.timestamp.desc())
        .limit(1)
    )
    metric = result.scalar_one_or_none()
    if not metric:
        return None

    return MetricsRead(
        cpu_percent=metric.cpu_percent,
        cpu_count=metric.cpu_count,
        load_average=metric.load_average,
        memory_total_mb=metric.memory_total_mb,
        memory_used_mb=metric.memory_used_mb,
        memory_percent=metric.memory_percent,
        disk_total_gb=metric.disk_total_gb,
        disk_used_gb=metric.disk_used_gb,
        disk_percent=metric.disk_percent,
        network_rx_bytes=metric.network_rx_bytes,
        network_tx_bytes=metric.network_tx_bytes,
        uptime_seconds=metric.uptime_seconds,
        process_count=metric.process_count,
    )


@router.get("/{server_id}/metrics/history", response_model=list[MetricsHistoryPoint])
async def get_metrics_history(
    server_id: uuid.UUID,
    hours: int = Query(default=24, ge=1, le=720),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get metrics history for a server."""
    since = datetime.now(timezone.utc) - timedelta(hours=hours)

    result = await db.execute(
        select(ServerMetric)
        .where(ServerMetric.server_id == server_id)
        .where(ServerMetric.timestamp >= since)
        .order_by(ServerMetric.timestamp.asc())
    )
    metrics = result.scalars().all()

    return [
        MetricsHistoryPoint(
            timestamp=m.timestamp,
            cpu_percent=m.cpu_percent,
            memory_percent=m.memory_percent,
            disk_percent=m.disk_percent,
        )
        for m in metrics
    ]


# ── Dashboard ────────────────────────────────────────────


@router.get("/dashboard/summary", response_model=DashboardSummary)
async def get_dashboard_summary(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get dashboard summary with all servers and their latest metrics."""
    result = await db.execute(select(Server).order_by(Server.name))
    servers = result.scalars().all()

    # Load alert rules
    rules_result = await db.execute(select(AlertRule).where(AlertRule.enabled == True))
    alert_rules = rules_result.scalars().all()

    server_summaries = []
    total_cpu = 0.0
    total_mem = 0.0
    total_disk = 0.0
    metrics_count = 0
    total_alerts = 0

    for srv in servers:
        # Get latest metric
        m_result = await db.execute(
            select(ServerMetric)
            .where(ServerMetric.server_id == srv.id)
            .order_by(ServerMetric.timestamp.desc())
            .limit(1)
        )
        metric = m_result.scalar_one_or_none()

        metrics_data = None
        alerts = []

        if metric:
            metrics_data = MetricsRead(
                cpu_percent=metric.cpu_percent,
                cpu_count=metric.cpu_count,
                load_average=metric.load_average,
                memory_total_mb=metric.memory_total_mb,
                memory_used_mb=metric.memory_used_mb,
                memory_percent=metric.memory_percent,
                disk_total_gb=metric.disk_total_gb,
                disk_used_gb=metric.disk_used_gb,
                disk_percent=metric.disk_percent,
                network_rx_bytes=metric.network_rx_bytes,
                network_tx_bytes=metric.network_tx_bytes,
                uptime_seconds=metric.uptime_seconds,
                process_count=metric.process_count,
            )

            total_cpu += metric.cpu_percent
            total_mem += metric.memory_percent
            total_disk += metric.disk_percent
            metrics_count += 1

            # Check alert rules
            for rule in alert_rules:
                if rule.server_id and str(rule.server_id) != str(srv.id):
                    continue
                value = getattr(metric, rule.metric, None)
                if value is None:
                    continue
                triggered = False
                if rule.operator == ">" and value > rule.threshold:
                    triggered = True
                elif rule.operator == ">=" and value >= rule.threshold:
                    triggered = True
                elif rule.operator == "<" and value < rule.threshold:
                    triggered = True
                elif rule.operator == "<=" and value <= rule.threshold:
                    triggered = True
                if triggered:
                    alerts.append(f"{rule.name}: {rule.metric}={value:.1f}% (seuil {rule.operator}{rule.threshold}%)")
                    total_alerts += 1

        server_summaries.append(ServerSummary(
            id=srv.id,
            name=srv.name,
            hostname=srv.hostname,
            ip_address=srv.ip_address,
            os_type=srv.os_type.value,
            status=srv.status.value,
            last_seen=srv.last_seen,
            metrics=metrics_data,
            alerts=alerts,
        ))

    online = sum(1 for s in servers if s.status == ServerStatus.ONLINE)
    offline = sum(1 for s in servers if s.status == ServerStatus.OFFLINE)
    unknown = sum(1 for s in servers if s.status == ServerStatus.UNKNOWN)

    return DashboardSummary(
        total_servers=len(servers),
        online_servers=online,
        offline_servers=offline,
        unknown_servers=unknown,
        total_alerts=total_alerts,
        avg_cpu=round(total_cpu / metrics_count, 1) if metrics_count else 0,
        avg_memory=round(total_mem / metrics_count, 1) if metrics_count else 0,
        avg_disk=round(total_disk / metrics_count, 1) if metrics_count else 0,
        servers=server_summaries,
    )


# ── Alert Rules ──────────────────────────────────────────


@router.get("/alerts/rules", response_model=list[AlertRuleRead])
async def list_alert_rules(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(AlertRule).order_by(AlertRule.name))
    return result.scalars().all()


@router.post("/alerts/rules", response_model=AlertRuleRead, status_code=201)
async def create_alert_rule(
    data: AlertRuleCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    rule = AlertRule(**data.model_dump())
    db.add(rule)
    await db.commit()
    await db.refresh(rule)
    return rule


@router.delete("/alerts/rules/{rule_id}", status_code=204)
async def delete_alert_rule(
    rule_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    await db.execute(delete(AlertRule).where(AlertRule.id == rule_id))
    await db.commit()


# ── Cleanup ──────────────────────────────────────────────


@router.post("/metrics/cleanup")
async def cleanup_old_metrics(
    days: int = Query(default=30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    """Delete metrics older than N days."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    result = await db.execute(
        delete(ServerMetric).where(ServerMetric.timestamp < cutoff)
    )
    await db.commit()
    return {"deleted": result.rowcount}
