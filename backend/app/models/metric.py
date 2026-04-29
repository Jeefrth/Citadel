from sqlalchemy import Float, Integer, BigInteger, String, DateTime, ForeignKey, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import UUIDMixin


class ServerMetric(UUIDMixin, Base):
    __tablename__ = "server_metrics"

    server_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), ForeignKey("servers.id"), nullable=False, index=True
    )
    timestamp: Mapped[DateTime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )

    cpu_percent: Mapped[float] = mapped_column(Float, default=0)
    cpu_count: Mapped[int] = mapped_column(Integer, default=1)
    load_average: Mapped[str] = mapped_column(String(50), default="")

    memory_total_mb: Mapped[int] = mapped_column(Integer, default=0)
    memory_used_mb: Mapped[int] = mapped_column(Integer, default=0)
    memory_percent: Mapped[float] = mapped_column(Float, default=0)

    disk_total_gb: Mapped[float] = mapped_column(Float, default=0)
    disk_used_gb: Mapped[float] = mapped_column(Float, default=0)
    disk_percent: Mapped[float] = mapped_column(Float, default=0)

    network_rx_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    network_tx_bytes: Mapped[int] = mapped_column(BigInteger, default=0)

    uptime_seconds: Mapped[int] = mapped_column(Integer, default=0)
    process_count: Mapped[int] = mapped_column(Integer, default=0)


class AlertRule(UUIDMixin, Base):
    __tablename__ = "alert_rules"

    server_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("servers.id"), nullable=True
    )  # None = applies to all servers
    metric: Mapped[str] = mapped_column(String(50), nullable=False)  # cpu_percent, memory_percent, disk_percent
    operator: Mapped[str] = mapped_column(String(5), default=">")  # >, <, >=, <=
    threshold: Mapped[float] = mapped_column(Float, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    enabled: Mapped[bool] = mapped_column(default=True)
