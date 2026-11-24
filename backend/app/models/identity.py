"""Identity trail (lot 6): Citadel sign-ins and the devices / keys in use."""

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import UUIDMixin


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
    device_id: Mapped[str | None] = mapped_column(UUID(as_uuid=True), ForeignKey("user_devices.id", ondelete="SET NULL"), nullable=True)
    method: Mapped[str] = mapped_column(String(20), nullable=False, default="entra")  # entra | access_key | ssh
    result: Mapped[str] = mapped_column(String(20), nullable=False, default="success")  # success | denied
    reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)
