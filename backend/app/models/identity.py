"""Identity trail (lot 6): Citadel sign-ins and the devices / keys in use."""

from sqlalchemy import Boolean, DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import UUIDMixin
from app.core.tenancy import TenantMixin



class UserDevice(UUIDMixin, Base):
    """A browser (device id sent by the front) or an access key seen calling the API."""
    __tablename__ = "user_devices"
    __table_args__ = (UniqueConstraint("user_id", "device_key", name="uq_user_device"),)

    user_id: Mapped[str] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    device_key: Mapped[str] = mapped_column(String(80), nullable=False, index=True)  # "web:<id>" | "key:<prefix>"
    kind: Mapped[str] = mapped_column(String(20), nullable=False, default="web")      # web | access_key
    label: Mapped[str] = mapped_column(String(255), nullable=False, default="")       # "Chrome · macOS"
    user_agent: Mapped[str | None] = mapped_column(String(500), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    first_seen: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_seen: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)
    revoked_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_by: Mapped[str | None] = mapped_column(String(255), nullable=True)


class LoginEvent(UUIDMixin, Base):
    """A sign-in: first request of a device, or after LOGIN_IDLE_HOURS of silence; failures too."""
    __tablename__ = "login_events"

    user_id: Mapped[str | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    user_name: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    org_id: Mapped[str | None] = mapped_column(UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True, index=True)
    device_id: Mapped[str | None] = mapped_column(UUID(as_uuid=True), ForeignKey("user_devices.id", ondelete="SET NULL"), nullable=True)
    method: Mapped[str] = mapped_column(String(20), nullable=False, default="entra")  # entra | access_key | ssh
    result: Mapped[str] = mapped_column(String(20), nullable=False, default="success")  # success | denied
    reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)


class UserSSHKey(UUIDMixin, Base):
    """Public key a user signs in to the SSH proxy with (lot 7)."""
    __tablename__ = "user_ssh_keys"

    user_id: Mapped[str] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    public_key: Mapped[str] = mapped_column(String(16000), nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_used_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class SSHConnectToken(UUIDMixin, Base):
    """Short-lived password for the SSH proxy (lot 7); only its SHA-256 is stored."""
    __tablename__ = "ssh_connect_tokens"

    user_id: Mapped[str] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    expires_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_used_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class CustomRole(TenantMixin, UUIDMixin, Base):
    """A named set of administration capabilities given on top of a base role (lot 7).
    The base role (operator / viewer) keeps capping the actions on servers."""
    __tablename__ = "custom_roles"
    __table_args__ = (UniqueConstraint("org_id", "name", name="uq_custom_roles_org_name"),)

    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    permissions: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
