"""Lot 7: account templates, encrypted backups, applications API, risk findings.

Revision ID: c1a7d0e5f009
Revises: c1a7d0e5f008
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c1a7d0e5f009"
down_revision: Union[str, None] = "c1a7d0e5f008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)
JSONB = postgresql.JSONB()


def _ts():
    return [sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now())]


def upgrade() -> None:
    op.create_table(
        "account_templates",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("name", sa.String(255), nullable=False, unique=True),
        sa.Column("description", sa.String(500)),
        sa.Column("username", sa.String(64), nullable=False),
        sa.Column("os_scope", sa.String(10), nullable=False, server_default="any"),
        sa.Column("secret_type", sa.String(20), nullable=False, server_default="password"),
        sa.Column("password_length", sa.Integer(), nullable=False, server_default="24"),
        sa.Column("privileged", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("sudo", sa.String(20), nullable=False, server_default="none"),
        sa.Column("groups", JSONB, nullable=False, server_default="[]"),
        sa.Column("rotation_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("rotation_interval_days", sa.Integer(), nullable=False, server_default="30"),
        *_ts(),
    )
    op.create_table(
        "account_backups",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("trigger", sa.String(20), nullable=False),
        sa.Column("destinations", JSONB, nullable=False, server_default="[]"),
        sa.Column("status", sa.String(20), nullable=False, server_default="running"),
        sa.Column("message", sa.String(1000)),
        sa.Column("accounts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("size_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("sha256", sa.String(64)),
        sa.Column("storage_type", sa.String(20)),
        sa.Column("storage_key", sa.String(500)),
    )
    op.create_index("ix_account_backups_created_at", "account_backups", ["created_at"])
    op.create_table(
        "applications",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("name", sa.String(255), nullable=False, unique=True),
        sa.Column("description", sa.String(500)),
        sa.Column("key_prefix", sa.String(16), nullable=False, unique=True),
        sa.Column("key_hash", sa.String(64), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
        sa.Column("allowed_ips", JSONB, nullable=False, server_default="[]"),
        sa.Column("server_ids", JSONB, nullable=False, server_default="[]"),
        sa.Column("node_ids", JSONB, nullable=False, server_default="[]"),
        sa.Column("labels", JSONB, nullable=False, server_default="[]"),
        sa.Column("accounts", JSONB, nullable=False, server_default="[]"),
        sa.Column("last_used_at", sa.DateTime(timezone=True)),
        sa.Column("last_used_ip", sa.String(45)),
        sa.Column("created_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL")),
        *_ts(),
    )
    op.create_index("ix_applications_key_prefix", "applications", ["key_prefix"])
    op.create_table(
        "risk_findings",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("key", sa.String(255), nullable=False, unique=True),
        sa.Column("category", sa.String(40), nullable=False),
        sa.Column("severity", sa.String(10), nullable=False),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("detail", sa.String(1000)),
        sa.Column("link", sa.String(255)),
        sa.Column("first_seen", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_seen", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True)),
        sa.Column("ignored", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("ignored_by", sa.String(255)),
        sa.Column("ignored_reason", sa.String(500)),
    )
    op.create_index("ix_risk_findings_category", "risk_findings", ["category"])
    op.create_index("ix_risk_findings_resolved_at", "risk_findings", ["resolved_at"])


def downgrade() -> None:
    op.drop_table("risk_findings")
    op.drop_table("applications")
    op.drop_table("account_backups")
    op.drop_table("account_templates")
