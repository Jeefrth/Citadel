from sqlalchemy import String, Boolean, DateTime
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import UUIDMixin, TimestampMixin, UserRole


class User(UUIDMixin, TimestampMixin, Base):
    """A person. Global (not owned by an organisation): rights come from the
    membership of the organisation the request runs in (OrgMembership), bound
    on the instance by core.auth.bind_user as role / custom_role / org."""
    __tablename__ = "users"

    entra_object_id: Mapped[str] = mapped_column(
        String(255), unique=True, nullable=False, index=True
    )
    email: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_platform_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, server_default="false")
    last_login: Mapped[DateTime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    audit_logs = relationship("AuditLog", back_populates="user")
    update_jobs = relationship("UpdateJob", back_populates="user")
    memberships = relationship("OrgMembership", back_populates="user", lazy="noload",
                               foreign_keys="OrgMembership.user_id")

    # Bound per request (not columns). Unbound = least privilege.
    role: UserRole = UserRole.VIEWER
    custom_role = None          # CustomRole of the current organisation
    org = None                  # Organization the request runs in

    @property
    def org_id(self):
        return self.org.id if self.org is not None else None

    @property
    def custom_role_id(self):
        return self.custom_role.id if self.custom_role is not None else None

    @property
    def custom_role_name(self) -> str | None:
        return self.custom_role.name if self.custom_role else None

    @property
    def permissions(self) -> list[str]:
        from app.core.auth import CAPABILITIES
        if self.role == UserRole.ADMIN:
            return list(CAPABILITIES)
        return [p for p in ((self.custom_role.permissions or []) if self.custom_role else []) if p in CAPABILITIES]
