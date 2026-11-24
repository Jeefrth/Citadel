"""Audit models (lot 4): command journal (D3), recording storage (D8), SIEM targets (D9)."""

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, LargeBinary, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import TimestampMixin, UUIDMixin


class CommandLog(UUIDMixin, Base):
    """Every command run through Citadel (terminal line or execute API), with its decision."""
    __tablename__ = "command_logs"

    session_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    user_id: Mapped[str] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    server_id: Mapped[str | None] = mapped_column(UUID(as_uuid=True), ForeignKey("servers.id", ondelete="SET NULL"), nullable=True, index=True)
    user_name: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    server_name: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    account: Mapped[str | None] = mapped_column(String(255), nullable=True)
    command: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(String(20), nullable=False)       # terminal | execute
    # allowed | alert | denied | review | approved_run
    decision: Mapped[str] = mapped_column(String(20), nullable=False, default="allowed")
    rule: Mapped[str | None] = mapped_column(String(255), nullable=True)
    exit_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    offset_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)  # position in the recording
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)


class RecordingStorage(UUIDMixin, TimestampMixin, Base):
    """Where finished recordings are stored. One active row; none = local disk."""
    __tablename__ = "recording_storage"

    type: Mapped[str] = mapped_column(String(20), nullable=False)          # local | s3 | azure
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # s3: {endpoint, bucket, region, access_key, secure, prefix}; azure: {container_url, prefix}
    config: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    # s3 secret key / azure SAS token, encrypted (vault transit)
    encrypted_secret: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    last_error: Mapped[str | None] = mapped_column(String(500), nullable=True)


class SiemTarget(UUIDMixin, TimestampMixin, Base):
    """Continuous export of audit and command events to a SIEM."""
    __tablename__ = "siem_targets"

    name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    transport: Mapped[str] = mapped_column(String(10), nullable=False)    # udp | tcp | tls | http
    format: Mapped[str] = mapped_column(String(10), nullable=False)       # json | cef | hec
    # syslog: {host, port, verify_tls}; http: {url, verify_tls, sourcetype, index}
    config: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    encrypted_secret: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)  # HTTP token
    streams: Mapped[list] = mapped_column(JSONB, nullable=False, default=lambda: ["audit", "commands"])
    # {"audit": {"ts": iso, "id": uuid}, "commands": {...}}: last event shipped
    cursors: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    sent_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    last_sent_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(String(500), nullable=True)
