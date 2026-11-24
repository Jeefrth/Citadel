"""Audit: command journal, recording storage, SIEM targets, RDP recordings

Revision ID: c1a7d0e5f004
Revises: c1a7d0e5f003
Create Date: 2026-11-24 20:10:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c1a7d0e5f004"
down_revision: Union[str, None] = "c1a7d0e5f003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)
JSONB = postgresql.JSONB


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.create_table(
        "command_logs",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("session_id", sa.String(255), nullable=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("server_id", UUID, sa.ForeignKey("servers.id", ondelete="SET NULL"), nullable=True),
        sa.Column("user_name", sa.String(255), nullable=False, server_default=""),
        sa.Column("server_name", sa.String(255), nullable=False, server_default=""),
        sa.Column("account", sa.String(255), nullable=True),
        sa.Column("command", sa.Text, nullable=False),
        sa.Column("source", sa.String(20), nullable=False),
        sa.Column("decision", sa.String(20), nullable=False, server_default="allowed"),
        sa.Column("rule", sa.String(255), nullable=True),
        sa.Column("exit_code", sa.Integer, nullable=True),
        sa.Column("offset_ms", sa.Integer, nullable=True),
        sa.Column("ip_address", sa.String(45), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    for col in ("session_id", "user_id", "server_id", "created_at"):
        op.create_index(f"ix_command_logs_{col}", "command_logs", [col])
    op.execute("CREATE INDEX ix_command_logs_command_trgm ON command_logs USING gin (command gin_trgm_ops)")

    op.create_table(
        "recording_storage",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("type", sa.String(20), nullable=False),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("config", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("encrypted_secret", sa.LargeBinary, nullable=True),
        sa.Column("last_error", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "siem_targets",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("name", sa.String(255), nullable=False, unique=True),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("transport", sa.String(10), nullable=False),
        sa.Column("format", sa.String(10), nullable=False),
        sa.Column("config", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("encrypted_secret", sa.LargeBinary, nullable=True),
        sa.Column("streams", JSONB, nullable=False, server_default=sa.text("'[\"audit\", \"commands\"]'::jsonb")),
        sa.Column("cursors", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("sent_count", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("last_sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    # Recordings: storage + RDP + kill metadata; keep them when a server is deleted
    op.alter_column("session_recordings", "events", nullable=True)
    for name, col in [
        ("protocol", sa.Column("protocol", sa.String(10), nullable=False, server_default="ssh")),
        ("account", sa.Column("account", sa.String(255), nullable=True)),
        ("client_ip", sa.Column("client_ip", sa.String(45), nullable=True)),
        ("storage_type", sa.Column("storage_type", sa.String(20), nullable=True)),
        ("storage_key", sa.Column("storage_key", sa.String(500), nullable=True)),
        ("sha256", sa.Column("sha256", sa.String(64), nullable=True)),
        ("terminated_by", sa.Column("terminated_by", sa.String(255), nullable=True)),
        ("termination_reason", sa.Column("termination_reason", sa.String(500), nullable=True)),
    ]:
        op.add_column("session_recordings", col)
    op.alter_column("session_recordings", "server_id", nullable=True)
    op.drop_constraint("session_recordings_server_id_fkey", "session_recordings", type_="foreignkey")
    op.create_foreign_key("session_recordings_server_id_fkey", "session_recordings", "servers",
                          ["server_id"], ["id"], ondelete="SET NULL")
    op.drop_constraint("alert_rules_server_id_fkey", "alert_rules", type_="foreignkey")
    op.create_foreign_key("alert_rules_server_id_fkey", "alert_rules", "servers",
                          ["server_id"], ["id"], ondelete="CASCADE")


def downgrade() -> None:
    op.drop_constraint("alert_rules_server_id_fkey", "alert_rules", type_="foreignkey")
    op.create_foreign_key("alert_rules_server_id_fkey", "alert_rules", "servers", ["server_id"], ["id"])
    op.drop_constraint("session_recordings_server_id_fkey", "session_recordings", type_="foreignkey")
    op.execute("DELETE FROM session_recordings WHERE server_id IS NULL")
    op.create_foreign_key("session_recordings_server_id_fkey", "session_recordings", "servers", ["server_id"], ["id"])
    op.alter_column("session_recordings", "server_id", nullable=False)
    for col in ["termination_reason", "terminated_by", "sha256", "storage_key", "storage_type",
                "client_ip", "account", "protocol"]:
        op.drop_column("session_recordings", col)
    op.execute("UPDATE session_recordings SET events = '[]'::jsonb WHERE events IS NULL")
    op.alter_column("session_recordings", "events", nullable=False)
    op.drop_table("siem_targets")
    op.drop_table("recording_storage")
    op.drop_table("command_logs")
