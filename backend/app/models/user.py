from sqlalchemy import String, Boolean, DateTime, Enum, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import UUIDMixin, TimestampMixin, UserRole


class User(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "users"

    entra_object_id: Mapped[str] = mapped_column(
        String(255), unique=True, nullable=False, index=True
    )
    email: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[UserRole] = mapped_column(
        Enum(UserRole), default=UserRole.VIEWER, nullable=False
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_login: Mapped[DateTime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    audit_logs = relationship("AuditLog", back_populates="user")
    update_jobs = relationship("UpdateJob", back_populates="user")
