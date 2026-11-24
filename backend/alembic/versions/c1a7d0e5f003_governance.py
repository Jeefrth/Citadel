"""Governance: connection / command rules, approvals, notifications

Revision ID: c1a7d0e5f003
Revises: c1a7d0e5f002
Create Date: 2026-11-24 19:45:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c1a7d0e5f003"
down_revision: Union[str, None] = "c1a7d0e5f002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)
JSONB = postgresql.JSONB
EMPTY = sa.text("'[]'::jsonb")


def _rule_columns():
    return [
        sa.Column("id", UUID, primary_key=True),
        sa.Column("name", sa.String(255), nullable=False, unique=True),
        sa.Column("description", sa.String(500), nullable=True),
        sa.Column("priority", sa.Integer, nullable=False, server_default="50"),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("user_ids", JSONB, nullable=False, server_default=EMPTY),
        sa.Column("group_ids", JSONB, nullable=False, server_default=EMPTY),
        sa.Column("server_ids", JSONB, nullable=False, server_default=EMPTY),
        sa.Column("node_ids", JSONB, nullable=False, server_default=EMPTY),
        sa.Column("labels", JSONB, nullable=False, server_default=EMPTY),
        sa.Column("accounts", JSONB, nullable=False, server_default=EMPTY),
        sa.Column("approver_group_ids", JSONB, nullable=False, server_default=EMPTY),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "connection_rules", *_rule_columns(),
        sa.Column("scope", sa.String(20), nullable=False, server_default="connect"),
        sa.Column("action", sa.String(20), nullable=False, server_default="deny"),
        sa.Column("source_ips", JSONB, nullable=False, server_default=EMPTY),
        sa.Column("time_windows", JSONB, nullable=False, server_default=EMPTY),
    )
    op.create_table(
        "command_rules", *_rule_columns(),
        sa.Column("action", sa.String(20), nullable=False, server_default="deny"),
        sa.Column("patterns", JSONB, nullable=False, server_default=EMPTY),
    )
    op.create_table(
        "approval_requests",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("number", sa.Integer, sa.Identity(start=1), nullable=False, unique=True),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("requester_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("server_id", UUID, sa.ForeignKey("servers.id", ondelete="CASCADE"), nullable=True),
        sa.Column("account_username", sa.String(255), nullable=True),
        sa.Column("command", sa.Text, nullable=True),
        sa.Column("reason", sa.Text, nullable=True),
        sa.Column("payload", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("rule_name", sa.String(255), nullable=True),
        sa.Column("approver_group_ids", JSONB, nullable=False, server_default=EMPTY),
        sa.Column("decided_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("decision_comment", sa.String(1000), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("grant_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("policy_id", UUID, sa.ForeignKey("access_policies.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_approval_requests_status", "approval_requests", ["status"])
    op.create_index("ix_approval_requests_requester_id", "approval_requests", ["requester_id"])
    op.create_table(
        "notifications",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("event", sa.String(100), nullable=False),
        sa.Column("level", sa.String(20), nullable=False, server_default="info"),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("body", sa.Text, nullable=True),
        sa.Column("link", sa.String(500), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_notifications_user_id", "notifications", ["user_id"])
    op.create_table(
        "notification_channels",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("name", sa.String(255), nullable=False, unique=True),
        sa.Column("type", sa.String(20), nullable=False),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("config", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("encrypted_secret", sa.LargeBinary, nullable=True),
        sa.Column("events", JSONB, nullable=False, server_default=EMPTY),
        sa.Column("min_level", sa.String(20), nullable=False, server_default="info"),
        sa.Column("last_sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    for t in ["notification_channels", "notifications", "approval_requests", "command_rules", "connection_rules"]:
        op.drop_table(t)
