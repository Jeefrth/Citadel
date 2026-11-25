"""Governance models (lot 3): connection ACL (C3), command ACL (C5),
approvals / access requests (G1, G2), notifications (G4).

Rule targets are stored as JSONB lists of ids / strings (empty list = any).
"""

import enum

from sqlalchemy import Boolean, DateTime, ForeignKey, Identity, Integer, LargeBinary, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import TimestampMixin, UUIDMixin
from app.core.tenancy import TenantMixin



class RuleScope(str, enum.Enum):
    LOGIN = "login"      # any authenticated call to Citadel
    CONNECT = "connect"  # terminal, RDP, one-shot execute on a server


class ConnectAction(str, enum.Enum):
    ALLOW = "allow"
    DENY = "deny"
    REVIEW = "review"    # needs an approval (connect scope only)


class CommandAction(str, enum.Enum):
    ALLOW = "allow"      # explicit allow, stops evaluation
    DENY = "deny"
    ALERT = "alert"      # runs, admins are notified
    REVIEW = "review"    # blocked until approved (one-shot grant)


class _TargetedRule:
    """Common columns for rules (mixin)."""
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=50)  # lower = first
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    user_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    group_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    server_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    node_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    labels: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    accounts: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    # Approvers for "review" (user groups); empty = admins
    approver_group_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)


class ConnectionRule(TenantMixin, _TargetedRule, UUIDMixin, TimestampMixin, Base):
    __tablename__ = "connection_rules"
    __table_args__ = (UniqueConstraint("org_id", "name", name="uq_connection_rules_org_name"),)

    scope: Mapped[str] = mapped_column(String(20), nullable=False, default=RuleScope.CONNECT.value)
    action: Mapped[str] = mapped_column(String(20), nullable=False, default=ConnectAction.DENY.value)
    # CIDRs; empty = any source
    source_ips: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    # [{"days": [0..6] (0 = Monday), "start": "08:00", "end": "18:00"}]; empty = any time
    time_windows: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)


class CommandRule(TenantMixin, _TargetedRule, UUIDMixin, TimestampMixin, Base):
    __tablename__ = "command_rules"
    __table_args__ = (UniqueConstraint("org_id", "name", name="uq_command_rules_org_name"),)

    action: Mapped[str] = mapped_column(String(20), nullable=False, default=CommandAction.DENY.value)
    # Python regexes, case-insensitive, searched anywhere in the command line
    patterns: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)


class ApprovalKind(str, enum.Enum):
    ACCESS = "access"    # temporary access request (G1)
    CONNECT = "connect"  # connection under a "review" rule
    COMMAND = "command"  # command under a "review" rule


class ApprovalStatus(str, enum.Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    CANCELLED = "cancelled"
    EXPIRED = "expired"
    USED = "used"        # one-shot command grant consumed


class ApprovalRequest(TenantMixin, UUIDMixin, Base):
    __tablename__ = "approval_requests"

    number: Mapped[int] = mapped_column(Integer, Identity(start=1), unique=True, nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=ApprovalStatus.PENDING.value, index=True)
    requester_id: Mapped[str] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    server_id: Mapped[str | None] = mapped_column(UUID(as_uuid=True), ForeignKey("servers.id", ondelete="CASCADE"), nullable=True)
    account_username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    command: Mapped[str | None] = mapped_column(Text, nullable=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # access: {server_ids, node_ids, actions, accounts, duration_hours}
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    rule_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    approver_group_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    decided_by: Mapped[str | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    decided_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    decision_comment: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    expires_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), nullable=False)   # pending deadline
    grant_until: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)  # validity once approved
    used_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    policy_id: Mapped[str | None] = mapped_column(UUID(as_uuid=True), ForeignKey("access_policies.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class Notification(TenantMixin, UUIDMixin, Base):
    """In-app notification (bell)."""
    __tablename__ = "notifications"

    user_id: Mapped[str] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    event: Mapped[str] = mapped_column(String(100), nullable=False)
    level: Mapped[str] = mapped_column(String(20), nullable=False, default="info")  # info | warning | critical
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    link: Mapped[str | None] = mapped_column(String(500), nullable=True)
    read_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class ChannelType(str, enum.Enum):
    EMAIL = "email"
    TEAMS = "teams"      # Teams "Workflows" incoming webhook (Adaptive Card)
    WEBHOOK = "webhook"  # generic JSON POST


class NotificationChannel(TenantMixin, UUIDMixin, TimestampMixin, Base):
    __tablename__ = "notification_channels"
    __table_args__ = (UniqueConstraint("org_id", "name", name="uq_notification_channels_org_name"),)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    type: Mapped[str] = mapped_column(String(20), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Non-secret settings, e.g. email: {host, port, starttls, username, sender, to: [], to_recipients: bool}
    config: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    # Secret part (SMTP password or webhook URL), encrypted like credentials (vault transit)
    encrypted_secret: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    events: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)  # empty = all events
    min_level: Mapped[str] = mapped_column(String(20), nullable=False, default="info")
    last_sent_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(String(500), nullable=True)
