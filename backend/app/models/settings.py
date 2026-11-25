import uuid

from sqlalchemy import ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import UUIDMixin


class AppSetting(UUIDMixin, Base):
    """Setting of an organisation (org_id set) or of the platform (org_id NULL).
    Not a TenantMixin: settings_service filters org_id explicitly so platform
    keys stay readable; RLS lets NULL rows through."""
    __tablename__ = "app_settings"
    __table_args__ = (UniqueConstraint("org_id", "key", name="uq_app_settings_org_key", postgresql_nulls_not_distinct=True),)

    org_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"),
                                                     nullable=True, index=True)
    key: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    value: Mapped[str] = mapped_column(Text, nullable=False, default="")
    description: Mapped[str] = mapped_column(String(500), nullable=True, default="")
