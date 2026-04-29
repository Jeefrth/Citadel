from sqlalchemy import String, Text, Enum, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import UUIDMixin, TimestampMixin, JobStatus


class UpdateJob(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "update_jobs"

    server_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), ForeignKey("servers.id"), nullable=False
    )
    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    type: Mapped[str] = mapped_column(String(50), nullable=False)
    packages: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    status: Mapped[JobStatus] = mapped_column(
        Enum(JobStatus), default=JobStatus.PENDING, nullable=False
    )
    scheduled_at: Mapped[DateTime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    started_at: Mapped[DateTime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[DateTime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    output: Mapped[str | None] = mapped_column(Text, nullable=True)

    server = relationship("Server", back_populates="update_jobs")
    user = relationship("User", back_populates="update_jobs")
