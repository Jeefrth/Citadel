"""Operations models (lot 5): zones & gateways (A4), jobs & playbooks (E2/E3),
cloud accounts (A8)."""

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, LargeBinary, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import TimestampMixin, UUIDMixin


class Zone(UUIDMixin, TimestampMixin, Base):
    """A network area only reachable through SSH gateways (jump hosts)."""
    __tablename__ = "zones"

    name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)

    gateways = relationship("Gateway", back_populates="zone", lazy="selectin",
                            order_by="Gateway.priority", cascade="all, delete-orphan")


class Gateway(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "gateways"

    zone_id: Mapped[str] = mapped_column(UUID(as_uuid=True), ForeignKey("zones.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    host: Mapped[str] = mapped_column(String(255), nullable=False)
    port: Mapped[int] = mapped_column(Integer, nullable=False, default=22)
    username: Mapped[str] = mapped_column(String(255), nullable=False)
    credential_id: Mapped[str | None] = mapped_column(UUID(as_uuid=True), ForeignKey("credentials.id", ondelete="SET NULL"), nullable=True)
    use_cert: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=10)  # lower = tried first
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    last_check_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_check_ok: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    last_check_message: Mapped[str | None] = mapped_column(String(500), nullable=True)

    zone = relationship("Zone", back_populates="gateways")
    credential = relationship("Credential", lazy="joined")


class Playbook(UUIDMixin, TimestampMixin, Base):
    """Ansible playbook stored in Citadel (YAML), run against servers as a job."""
    __tablename__ = "playbooks"

    name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    # Default extra vars (JSON object) merged with the ones given at run time
    variables: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_by: Mapped[str | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class Job(UUIDMixin, TimestampMixin, Base):
    """A command or a playbook run on several servers."""
    __tablename__ = "jobs"

    kind: Mapped[str] = mapped_column(String(20), nullable=False)        # command | playbook
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    command: Mapped[str | None] = mapped_column(Text, nullable=True)
    playbook_id: Mapped[str | None] = mapped_column(UUID(as_uuid=True), ForeignKey("playbooks.id", ondelete="SET NULL"), nullable=True)
    extra_vars: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    # How targets were chosen (kept for display / re-run): {server_ids, node_ids, labels}
    selector: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    account_id: Mapped[str | None] = mapped_column(UUID(as_uuid=True), nullable=True)  # None = default account
    parallelism: Mapped[int] = mapped_column(Integer, nullable=False, default=10)
    timeout: Mapped[int] = mapped_column(Integer, nullable=False, default=60)
    # pending | running | success | partial | failed | cancelled
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending", index=True)
    user_id: Mapped[str] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    client_ip: Mapped[str | None] = mapped_column(String(64), nullable=True)  # launcher's IP, for connection/command ACLs
    started_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    output: Mapped[str | None] = mapped_column(Text, nullable=True)  # playbook log (ansible output)

    targets = relationship("JobTarget", back_populates="job", lazy="selectin",
                           cascade="all, delete-orphan", order_by="JobTarget.server_name")


class JobTarget(UUIDMixin, Base):
    __tablename__ = "job_targets"
    __table_args__ = (UniqueConstraint("job_id", "server_id", name="uq_job_target"),)

    job_id: Mapped[str] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True)
    server_id: Mapped[str | None] = mapped_column(UUID(as_uuid=True), ForeignKey("servers.id", ondelete="SET NULL"), nullable=True)
    server_name: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    account: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # pending | running | success | failed | skipped | cancelled
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    exit_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    stdout: Mapped[str | None] = mapped_column(Text, nullable=True)
    stderr: Mapped[str | None] = mapped_column(Text, nullable=True)
    message: Mapped[str | None] = mapped_column(String(500), nullable=True)  # why skipped / failed
    started_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    job = relationship("Job", back_populates="targets")


class CloudAccount(UUIDMixin, TimestampMixin, Base):
    """Cloud inventory source (Azure for now): VMs are imported as servers."""
    __tablename__ = "cloud_accounts"

    name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    provider: Mapped[str] = mapped_column(String(20), nullable=False, default="azure")
    # azure: {tenant_id, client_id, subscription_ids: [], use_public_ip: bool, only_running: bool}
    config: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    encrypted_secret: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)  # client secret
    node_id: Mapped[str | None] = mapped_column(UUID(as_uuid=True), ForeignKey("nodes.id", ondelete="SET NULL"), nullable=True)
    zone_id: Mapped[str | None] = mapped_column(UUID(as_uuid=True), ForeignKey("zones.id", ondelete="SET NULL"), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sync_interval_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=60)
    last_sync_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_sync_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    last_sync_message: Mapped[str | None] = mapped_column(String(1000), nullable=True)
