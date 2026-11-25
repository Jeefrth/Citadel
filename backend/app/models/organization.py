"""Organisations (SaaS phase 1): customers isolated from each other, and the
membership of users in them (the role is per organisation)."""

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, LargeBinary, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import UserRole, UUIDMixin


class Organization(UUIDMixin, Base):
    __tablename__ = "organizations"

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    slug: Mapped[str] = mapped_column(String(63), unique=True, nullable=False, index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)  # the pre-SaaS data
    # Encryption: own Transit key (None = default key, default org only)
    transit_key: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # SSH CA: own key pair (None = platform CA, default org only); private key encrypted with the org key
    ssh_ca_public: Mapped[str | None] = mapped_column(Text, nullable=True)
    ssh_ca_private: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    entra_tenant_id: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True)  # phase 3
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class OrgMembership(UUIDMixin, Base):
    __tablename__ = "org_memberships"
    __table_args__ = (UniqueConstraint("org_id", "user_id", name="uq_membership"),)

    org_id: Mapped[str] = mapped_column(UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    role: Mapped[UserRole] = mapped_column(Enum(UserRole, name="userrole", create_type=False), nullable=False, default=UserRole.VIEWER)
    custom_role_id: Mapped[str | None] = mapped_column(UUID(as_uuid=True), ForeignKey("custom_roles.id", ondelete="SET NULL"), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    organization = relationship("Organization", lazy="joined")
    user = relationship("User", back_populates="memberships", foreign_keys=[user_id], lazy="noload")
    # CustomRole is tenant data: loaded explicitly by bind_user inside the org context
    custom_role = relationship("CustomRole", lazy="noload")


class OrgInvitation(UUIDMixin, Base):
    """A person invited by e-mail before their first sign-in: becomes a membership then."""
    __tablename__ = "org_invitations"
    __table_args__ = (UniqueConstraint("org_id", "email", name="uq_invitation"),)

    org_id: Mapped[str] = mapped_column(UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    role: Mapped[UserRole] = mapped_column(Enum(UserRole, name="userrole", create_type=False), nullable=False, default=UserRole.VIEWER)
    invited_by: Mapped[str | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
