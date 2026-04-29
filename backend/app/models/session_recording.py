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
    server_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), ForeignKey("servers.id"), nullable=False, index=True
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
    events: Mapped[list] = mapped_column(JSONB, default=list)

    duration_seconds: Mapped[int] = mapped_column(Integer, default=0)
    event_count: Mapped[int] = mapped_column(Integer, default=0)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
