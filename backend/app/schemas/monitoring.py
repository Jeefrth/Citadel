import uuid
from datetime import datetime

from pydantic import BaseModel


class MetricsRead(BaseModel):
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


class MetricsHistoryPoint(BaseModel):
    timestamp: datetime
    cpu_percent: float
    memory_percent: float
    disk_percent: float

    model_config = {"from_attributes": True}


class ServerSummary(BaseModel):
    id: uuid.UUID
    name: str
    hostname: str
    ip_address: str
    os_type: str
    status: str
    last_seen: datetime | None
    metrics: MetricsRead | None = None
    alerts: list[str] = []


class DashboardSummary(BaseModel):
    total_servers: int
    online_servers: int
    offline_servers: int
    unknown_servers: int
    total_alerts: int
    avg_cpu: float
    avg_memory: float
    avg_disk: float
    servers: list[ServerSummary]


class AlertRuleCreate(BaseModel):
    server_id: uuid.UUID | None = None
    metric: str  # cpu_percent, memory_percent, disk_percent
    operator: str = ">"
    threshold: float
    name: str
    enabled: bool = True


class AlertRuleRead(BaseModel):
    id: uuid.UUID
    server_id: uuid.UUID | None
    metric: str
    operator: str
    threshold: float
    name: str
    enabled: bool

    model_config = {"from_attributes": True}


class ActiveAlert(BaseModel):
    server_id: str
    server_name: str
    rule_name: str
    metric: str
    current_value: float
    threshold: float
    operator: str
