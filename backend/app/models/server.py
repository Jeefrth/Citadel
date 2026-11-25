from sqlalchemy import String, Integer, Enum, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import UUIDMixin, TimestampMixin, OSType, ServerStatus
from app.core.tenancy import TenantMixin



class Server(TenantMixin, UUIDMixin, TimestampMixin, Base):
    __tablename__ = "servers"
    __table_args__ = (UniqueConstraint("org_id", "cloud_ref", name="uq_servers_org_cloud_ref"),)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    hostname: Mapped[str] = mapped_column(String(255), nullable=False)
    ip_address: Mapped[str] = mapped_column(String(45), nullable=False)
    os_type: Mapped[OSType] = mapped_column(Enum(OSType), nullable=False)
    os_version: Mapped[str | None] = mapped_column(String(100), nullable=True)
    ssh_port: Mapped[int] = mapped_column(Integer, default=22)
    winrm_port: Mapped[int] = mapped_column(Integer, default=5985)
    rdp_port: Mapped[int] = mapped_column(Integer, default=3389)
    status: Mapped[ServerStatus] = mapped_column(
        Enum(ServerStatus), default=ServerStatus.UNKNOWN
    )
    last_seen: Mapped[DateTime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Labels: flat {"key": "value"} map (A2)
    tags: Mapped[dict | None] = mapped_column(JSONB, nullable=True, default=dict)

    accounts_discovered_at: Mapped[DateTime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Network zone reached through SSH gateways (A4); None = direct
    zone_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("zones.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Cloud inventory link (A8): "azure:<vm resource id>"; cloud_state: present | missing
    cloud_ref: Mapped[str | None] = mapped_column(String(500), nullable=True)
    cloud_state: Mapped[str | None] = mapped_column(String(20), nullable=True)

    node_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("nodes.id", ondelete="SET NULL"), nullable=True, index=True
    )

    node = relationship("Node")
    zone = relationship("Zone", lazy="selectin")
    accounts = relationship(
        "Account", back_populates="server", cascade="all, delete-orphan",
        lazy="selectin", order_by="Account.username",
    )
    audit_logs = relationship("AuditLog", back_populates="server")
    update_jobs = relationship("UpdateJob", back_populates="server")

    @property
    def default_account(self):
        for acc in self.accounts:
            if acc.is_default and acc.is_active:
                return acc
        return None
