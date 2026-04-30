from sqlalchemy import String, Integer, Boolean, Enum, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import UUIDMixin, TimestampMixin, OSType, ServerStatus


class ServerGroup(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "server_groups"

    name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)

    servers = relationship("Server", back_populates="group")


class Server(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "servers"

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    hostname: Mapped[str] = mapped_column(String(255), nullable=False)
    ip_address: Mapped[str] = mapped_column(String(45), nullable=False)
    os_type: Mapped[OSType] = mapped_column(Enum(OSType), nullable=False)
    os_version: Mapped[str | None] = mapped_column(String(100), nullable=True)
    ssh_port: Mapped[int] = mapped_column(Integer, default=22)
    winrm_port: Mapped[int] = mapped_column(Integer, default=5985)
    status: Mapped[ServerStatus] = mapped_column(
        Enum(ServerStatus), default=ServerStatus.UNKNOWN
    )
    last_seen: Mapped[DateTime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    tags: Mapped[dict | None] = mapped_column(JSONB, nullable=True, default=dict)

    # Ephemeral cert mode: connect with auto-generated cert (no credential needed)
    ssh_username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    cert_auth_enabled: Mapped[bool] = mapped_column(Boolean, default=False)

    credential_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("credentials.id"), nullable=True
    )
    group_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("server_groups.id"), nullable=True
    )

    credential = relationship("Credential", back_populates="servers")
    group = relationship("ServerGroup", back_populates="servers")
    audit_logs = relationship("AuditLog", back_populates="server")
    update_jobs = relationship("UpdateJob", back_populates="server")
