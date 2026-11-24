"""Privileged Access Management core models.

- Node: hierarchical asset tree (A1)
- Account: per-server connection accounts (B1)
- UserGroup: groups of users, target of access policies
- AccessPolicy: who can do what on which servers with which accounts (C1, B9)
- UserFavorite: per-user favourite servers (A5)
- AccessKey: personal API tokens (F4)
"""

import enum

from sqlalchemy import (
    Boolean, Column, DateTime, ForeignKey, Integer, LargeBinary, String, Table, UniqueConstraint, func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import TimestampMixin, UUIDMixin


class PolicyAction(str, enum.Enum):
    CONNECT = "connect"   # interactive terminal / RDP
    EXECUTE = "execute"   # one-shot commands, update apply
    COPY = "copy"         # RDP clipboard: remote -> local
    PASTE = "paste"       # RDP clipboard: local -> remote
    UPLOAD = "upload"     # file transfer to the server (SFTP)
    DOWNLOAD = "download" # file transfer from the server (SFTP)


# Virtual account aliases usable in AccessPolicy.accounts (B9)
ACCOUNT_ALL = "@ALL"      # every real account of the server
ACCOUNT_USER = "@USER"    # same username as the Citadel user (ephemeral cert)
ACCOUNT_INPUT = "@INPUT"  # username/password typed at connection time
VIRTUAL_ACCOUNTS = {ACCOUNT_ALL, ACCOUNT_USER, ACCOUNT_INPUT}


class Node(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "nodes"
    __table_args__ = (UniqueConstraint("parent_id", "name", name="uq_node_parent_name"),)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    parent_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("nodes.id", ondelete="CASCADE"), nullable=True, index=True
    )
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)


class Account(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "accounts"
    __table_args__ = (UniqueConstraint("server_id", "username", name="uq_account_server_username"),)

    server_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), ForeignKey("servers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    username: Mapped[str] = mapped_column(String(255), nullable=False)
    # Secret source: a stored Credential (password / key), or the Mini-CA (use_cert)
    credential_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("credentials.id", ondelete="SET NULL"), nullable=True
    )
    use_cert: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    privileged: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Default account = the one used for automation (monitoring, updates, commands)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Automatic password rotation (B3)
    rotation_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    rotation_interval_days: Mapped[int] = mapped_column(Integer, default=30, nullable=False)
    last_rotated_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_rotation_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    last_rotation_message: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Secret verification (B6): unknown | ok | failed | error
    verify_status: Mapped[str] = mapped_column(String(20), default="unknown", nullable=False)
    verify_message: Mapped[str | None] = mapped_column(String(500), nullable=True)
    last_verified_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    server = relationship("Server", back_populates="accounts")
    credential = relationship("Credential", lazy="joined")


class SecretStatus(str, enum.Enum):
    PENDING = "pending"   # generated, not yet applied on the target
    ACTIVE = "active"     # current secret
    RETIRED = "retired"   # replaced by a newer one
    FAILED = "failed"     # target change failed, never active


class SecretHistory(UUIDMixin, TimestampMixin, Base):
    """Every secret Citadel generated for an account, encrypted.

    The new secret is persisted BEFORE it is applied on the target, so a
    crash between "changed on the server" and "saved" never loses it.
    """
    __tablename__ = "secret_history"

    account_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    encrypted_secret: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=SecretStatus.PENDING.value)
    reason: Mapped[str] = mapped_column(String(50), nullable=False, default="rotation")
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    actor_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    activated_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DiscoveredAccount(UUIDMixin, Base):
    """OS accounts found on a server by discovery (B5)."""
    __tablename__ = "discovered_accounts"
    __table_args__ = (UniqueConstraint("server_id", "username", name="uq_discovered_server_username"),)

    server_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), ForeignKey("servers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    username: Mapped[str] = mapped_column(String(255), nullable=False)
    uid: Mapped[str | None] = mapped_column(String(100), nullable=True)
    shell: Mapped[str | None] = mapped_column(String(255), nullable=True)
    enabled: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    privileged: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    last_login: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # new | ignored | gone (managed is computed by matching Account.username)
    status: Mapped[str] = mapped_column(String(20), default="new", nullable=False)
    first_seen: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())


user_group_members = Table(
    "user_group_members",
    Base.metadata,
    Column("group_id", UUID(as_uuid=True), ForeignKey("user_groups.id", ondelete="CASCADE"), primary_key=True),
    Column("user_id", UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
)


class UserGroup(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "user_groups"

    name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)

    users = relationship("User", secondary=user_group_members, lazy="selectin")


policy_users = Table(
    "policy_users", Base.metadata,
    Column("policy_id", UUID(as_uuid=True), ForeignKey("access_policies.id", ondelete="CASCADE"), primary_key=True),
    Column("user_id", UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
)
policy_groups = Table(
    "policy_groups", Base.metadata,
    Column("policy_id", UUID(as_uuid=True), ForeignKey("access_policies.id", ondelete="CASCADE"), primary_key=True),
    Column("group_id", UUID(as_uuid=True), ForeignKey("user_groups.id", ondelete="CASCADE"), primary_key=True),
)
policy_servers = Table(
    "policy_servers", Base.metadata,
    Column("policy_id", UUID(as_uuid=True), ForeignKey("access_policies.id", ondelete="CASCADE"), primary_key=True),
    Column("server_id", UUID(as_uuid=True), ForeignKey("servers.id", ondelete="CASCADE"), primary_key=True),
)
policy_nodes = Table(
    "policy_nodes", Base.metadata,
    Column("policy_id", UUID(as_uuid=True), ForeignKey("access_policies.id", ondelete="CASCADE"), primary_key=True),
    Column("node_id", UUID(as_uuid=True), ForeignKey("nodes.id", ondelete="CASCADE"), primary_key=True),
)


class AccessPolicy(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "access_policies"

    name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    valid_from: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    valid_until: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # PolicyAction values
    actions: Mapped[list] = mapped_column(JSONB, nullable=False, default=lambda: ["connect"])
    # Account usernames and/or virtual aliases (@ALL, @USER, @INPUT)
    accounts: Mapped[list] = mapped_column(JSONB, nullable=False, default=lambda: ["@ALL"])
    # Label selectors "key=value": a server matching ANY of them is included
    labels: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    created_by: Mapped[str | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    users = relationship("User", secondary=policy_users, lazy="selectin")
    groups = relationship("UserGroup", secondary=policy_groups, lazy="selectin")
    servers = relationship("Server", secondary=policy_servers, lazy="selectin")
    nodes = relationship("Node", secondary=policy_nodes, lazy="selectin")


class UserFavorite(Base):
    __tablename__ = "user_favorites"

    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    server_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), ForeignKey("servers.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AccessKey(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "access_keys"

    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # Public lookup part of the token (ctk_<prefix>_<secret>)
    prefix: Mapped[str] = mapped_column(String(16), unique=True, nullable=False, index=True)
    # SHA-256 of the full token, never the token itself
    key_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_used_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    user = relationship("User", lazy="joined")
