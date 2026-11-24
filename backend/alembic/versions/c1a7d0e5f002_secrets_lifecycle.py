"""Secrets lifecycle: rotation, verification, secret history, discovered accounts

Revision ID: c1a7d0e5f002
Revises: c1a7d0e5f001
Create Date: 2026-11-24 19:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c1a7d0e5f002"
down_revision: Union[str, None] = "c1a7d0e5f001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.add_column("accounts", sa.Column("rotation_enabled", sa.Boolean, nullable=False, server_default=sa.text("false")))
    op.add_column("accounts", sa.Column("rotation_interval_days", sa.Integer, nullable=False, server_default="30"))
    op.add_column("accounts", sa.Column("last_rotated_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("accounts", sa.Column("last_rotation_status", sa.String(20), nullable=True))
    op.add_column("accounts", sa.Column("last_rotation_message", sa.String(500), nullable=True))
    op.add_column("accounts", sa.Column("verify_status", sa.String(20), nullable=False, server_default="unknown"))
    op.add_column("accounts", sa.Column("verify_message", sa.String(500), nullable=True))
    op.add_column("accounts", sa.Column("last_verified_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("servers", sa.Column("accounts_discovered_at", sa.DateTime(timezone=True), nullable=True))

    op.create_table(
        "secret_history",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("account_id", UUID, sa.ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("encrypted_secret", sa.LargeBinary, nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("reason", sa.String(50), nullable=False, server_default="rotation"),
        sa.Column("error", sa.String(500), nullable=True),
        sa.Column("actor_id", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("activated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_secret_history_account_id", "secret_history", ["account_id"])

    op.create_table(
        "discovered_accounts",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("server_id", UUID, sa.ForeignKey("servers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("username", sa.String(255), nullable=False),
        sa.Column("uid", sa.String(100), nullable=True),
        sa.Column("shell", sa.String(255), nullable=True),
        sa.Column("enabled", sa.Boolean, nullable=True),
        sa.Column("privileged", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("last_login", sa.String(100), nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="new"),
        sa.Column("first_seen", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_seen", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("server_id", "username", name="uq_discovered_server_username"),
    )
    op.create_index("ix_discovered_accounts_server_id", "discovered_accounts", ["server_id"])


def downgrade() -> None:
    op.drop_table("discovered_accounts")
    op.drop_table("secret_history")
    op.drop_column("servers", "accounts_discovered_at")
    for col in ["last_verified_at", "verify_message", "verify_status", "last_rotation_message",
                "last_rotation_status", "last_rotated_at", "rotation_interval_days", "rotation_enabled"]:
        op.drop_column("accounts", col)
