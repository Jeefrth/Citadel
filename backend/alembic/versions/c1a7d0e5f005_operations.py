"""Operations: zones & gateways, jobs & playbooks, cloud accounts

Revision ID: c1a7d0e5f005
Revises: c1a7d0e5f004
Create Date: 2026-11-24 22:30:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c1a7d0e5f005"
down_revision: Union[str, None] = "c1a7d0e5f004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)
JSONB = postgresql.JSONB


def _ts():
    return sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False)


def upgrade() -> None:
    op.create_table(
        "zones",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("name", sa.String(255), nullable=False, unique=True),
        sa.Column("description", sa.String(500), nullable=True),
        _ts(),
    )
    op.create_table(
        "gateways",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("zone_id", UUID, sa.ForeignKey("zones.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("host", sa.String(255), nullable=False),
        sa.Column("port", sa.Integer, nullable=False, server_default="22"),
        sa.Column("username", sa.String(255), nullable=False),
        sa.Column("credential_id", UUID, sa.ForeignKey("credentials.id", ondelete="SET NULL"), nullable=True),
        sa.Column("use_cert", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("priority", sa.Integer, nullable=False, server_default="10"),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("last_check_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_check_ok", sa.Boolean, nullable=True),
        sa.Column("last_check_message", sa.String(500), nullable=True),
        _ts(),
    )
    op.add_column("servers", sa.Column("zone_id", UUID, nullable=True))
    op.create_foreign_key("servers_zone_id_fkey", "servers", "zones", ["zone_id"], ["id"], ondelete="SET NULL")
    op.create_index("ix_servers_zone_id", "servers", ["zone_id"])
    op.add_column("servers", sa.Column("cloud_ref", sa.String(500), nullable=True))
    op.create_unique_constraint("uq_servers_cloud_ref", "servers", ["cloud_ref"])
    op.add_column("servers", sa.Column("cloud_state", sa.String(20), nullable=True))

    op.create_table(
        "playbooks",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("name", sa.String(255), nullable=False, unique=True),
        sa.Column("description", sa.String(1000), nullable=True),
        sa.Column("content", sa.Text, nullable=False),
        sa.Column("variables", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        _ts(),
    )
    op.create_table(
        "jobs",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("command", sa.Text, nullable=True),
        sa.Column("playbook_id", UUID, sa.ForeignKey("playbooks.id", ondelete="SET NULL"), nullable=True),
        sa.Column("extra_vars", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("selector", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("account_id", UUID, nullable=True),
        sa.Column("parallelism", sa.Integer, nullable=False, server_default="10"),
        sa.Column("timeout", sa.Integer, nullable=False, server_default="60"),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending", index=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("output", sa.Text, nullable=True),
        _ts(),
    )
    op.create_table(
        "job_targets",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("job_id", UUID, sa.ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("server_id", UUID, sa.ForeignKey("servers.id", ondelete="SET NULL"), nullable=True),
        sa.Column("server_name", sa.String(255), nullable=False, server_default=""),
        sa.Column("account", sa.String(255), nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("exit_code", sa.Integer, nullable=True),
        sa.Column("stdout", sa.Text, nullable=True),
        sa.Column("stderr", sa.Text, nullable=True),
        sa.Column("message", sa.String(500), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("job_id", "server_id", name="uq_job_target"),
    )
    op.create_table(
        "cloud_accounts",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("name", sa.String(255), nullable=False, unique=True),
        sa.Column("provider", sa.String(20), nullable=False, server_default="azure"),
        sa.Column("config", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("encrypted_secret", sa.LargeBinary, nullable=True),
        sa.Column("node_id", UUID, sa.ForeignKey("nodes.id", ondelete="SET NULL"), nullable=True),
        sa.Column("zone_id", UUID, sa.ForeignKey("zones.id", ondelete="SET NULL"), nullable=True),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("sync_interval_minutes", sa.Integer, nullable=False, server_default="60"),
        sa.Column("last_sync_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_sync_status", sa.String(20), nullable=True),
        sa.Column("last_sync_message", sa.String(1000), nullable=True),
        _ts(),
    )


def downgrade() -> None:
    op.drop_table("cloud_accounts")
    op.drop_table("job_targets")
    op.drop_table("jobs")
    op.drop_table("playbooks")
    op.drop_column("servers", "cloud_state")
    op.drop_constraint("uq_servers_cloud_ref", "servers", type_="unique")
    op.drop_column("servers", "cloud_ref")
    op.drop_index("ix_servers_zone_id", "servers")
    op.drop_constraint("servers_zone_id_fkey", "servers", type_="foreignkey")
    op.drop_column("servers", "zone_id")
    op.drop_table("gateways")
    op.drop_table("zones")
