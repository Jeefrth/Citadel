from sqlalchemy import String, Boolean, DateTime, Enum, ForeignKey, func
from sqlalchemy.dialects.postgresql import UUID
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

    custom_role_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("custom_roles.id", ondelete="SET NULL"), nullable=True
    )
    custom_role = relationship("CustomRole", lazy="selectin")

    audit_logs = relationship("AuditLog", back_populates="user")

    @property
    def custom_role_name(self) -> str | None:
        return self.custom_role.name if self.custom_role else None

    @property
    def permissions(self) -> list[str]:
        from app.core.auth import CAPABILITIES
        if self.role == UserRole.ADMIN:
            return list(CAPABILITIES)
        return [p for p in ((self.custom_role.permissions or []) if self.custom_role else []) if p in CAPABILITIES]
    update_jobs = relationship("UpdateJob", back_populates="user")
