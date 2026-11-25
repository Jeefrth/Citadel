"""Kubernetes (lot 8): clusters and access rules on namespaces."""

from urllib.parse import urlparse

from sqlalchemy import Boolean, DateTime, ForeignKey, LargeBinary, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import TimestampMixin, UUIDMixin

K8S_ACTIONS = ("view", "logs", "exec", "manage")


class K8sCluster(UUIDMixin, TimestampMixin, Base):
    """A cluster reached with a service account token (encrypted in the vault)."""
    __tablename__ = "k8s_clusters"

    name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    api_url: Mapped[str] = mapped_column(String(500), nullable=False)        # https://host:6443
    ca_cert: Mapped[str | None] = mapped_column(Text, nullable=True)          # PEM; empty = system CAs
    skip_tls_verify: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    encrypted_token: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    node_id: Mapped[str | None] = mapped_column(UUID(as_uuid=True), ForeignKey("nodes.id", ondelete="SET NULL"), nullable=True)
    zone_id: Mapped[str | None] = mapped_column(UUID(as_uuid=True), ForeignKey("zones.id", ondelete="SET NULL"), nullable=True)
    tags: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    version: Mapped[str | None] = mapped_column(String(50), nullable=True)
    last_check_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_check_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    last_check_message: Mapped[str | None] = mapped_column(String(500), nullable=True)

    zone = relationship("Zone", lazy="selectin")

    @property
    def ip_address(self) -> str:   # what services.routing keys on
        return urlparse(self.api_url).hostname or ""

    @property
    def api_port(self) -> int:
        u = urlparse(self.api_url)
        return u.port or (443 if u.scheme == "https" else 80)


class K8sPolicy(UUIDMixin, TimestampMixin, Base):
    """Who may do what in which namespaces of which clusters. Same rules as server
    access policies: the role caps the actions (viewer: view and logs only)."""
    __tablename__ = "k8s_policies"

    name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    valid_from: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    valid_until: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    user_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    group_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    cluster_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    namespaces: Mapped[list] = mapped_column(JSONB, nullable=False, default=lambda: ["*"])   # names or globs ("team-*")
    actions: Mapped[list] = mapped_column(JSONB, nullable=False, default=lambda: ["view", "logs"])
    created_by: Mapped[str | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
