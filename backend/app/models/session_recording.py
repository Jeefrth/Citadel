from sqlalchemy import String, Integer, DateTime, ForeignKey, Text, func
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import UUIDMixin


class SessionRecording(UUIDMixin, Base):
    __tablename__ = "session_recordings"

    session_id: Mapped[str] = mapped_column(
        String(255), unique=True, nullable=False, index=True
    )
    # SET NULL: recordings outlive the server they were made on (audit)
    server_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("servers.id", ondelete="SET NULL"), nullable=True, index=True
    )
    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    server_name: Mapped[str] = mapped_column(String(255), default="")
    user_name: Mapped[str] = mapped_column(String(255), default="")

    started_at: Mapped[DateTime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    ended_at: Mapped[DateTime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Events: list of {"t": timestamp_ms, "type": "o"|"i", "data": "base64"}
    # "o" = output (server → client), "i" = input (client → server)
    # Kept for legacy rows; new recordings live in the recording storage (storage_key)
    events: Mapped[list | None] = mapped_column(JSONB, nullable=True, default=None)

    protocol: Mapped[str] = mapped_column(String(10), nullable=False, default="ssh")  # ssh | rdp
    account: Mapped[str | None] = mapped_column(String(255), nullable=True)
    client_ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    storage_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    storage_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)  # of the stored object
    terminated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    termination_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)

    duration_seconds: Mapped[int] = mapped_column(Integer, default=0)
    event_count: Mapped[int] = mapped_column(Integer, default=0)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
