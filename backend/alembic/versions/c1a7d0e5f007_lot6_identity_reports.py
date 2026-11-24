"""Lot 6: sign-in journal and devices, policy expiry reminders, cloud review queue.

Revision ID: c1a7d0e5f007
Revises: c1a7d0e5f006
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c1a7d0e5f007"
down_revision: Union[str, None] = "c1a7d0e5f006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        "user_devices",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("device_key", sa.String(80), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False, server_default="web"),
        sa.Column("label", sa.String(255), nullable=False, server_default=""),
        sa.Column("user_agent", sa.String(500)),
        sa.Column("ip_address", sa.String(45)),
        sa.Column("first_seen", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_seen", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("revoked_by", sa.String(255)),
        sa.UniqueConstraint("user_id", "device_key", name="uq_user_device"),
    )
    op.create_index("ix_user_devices_user_id", "user_devices", ["user_id"])
    op.create_index("ix_user_devices_device_key", "user_devices", ["device_key"])
    op.create_index("ix_user_devices_last_seen", "user_devices", ["last_seen"])

    op.create_table(
        "login_events",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("user_name", sa.String(255), nullable=False, server_default=""),
        sa.Column("device_id", UUID, sa.ForeignKey("user_devices.id", ondelete="SET NULL")),
        sa.Column("method", sa.String(20), nullable=False, server_default="entra"),
        sa.Column("result", sa.String(20), nullable=False, server_default="success"),
        sa.Column("reason", sa.String(255)),
        sa.Column("ip_address", sa.String(45)),
        sa.Column("user_agent", sa.String(500)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_login_events_user_id", "login_events", ["user_id"])
    op.create_index("ix_login_events_created_at", "login_events", ["created_at"])

    op.add_column("access_policies", sa.Column("expiry_notified_at", sa.DateTime(timezone=True)))
    op.add_column("cloud_accounts", sa.Column("review_new", sa.Boolean(), nullable=False, server_default=sa.false()))

    op.create_table(
        "cloud_pending_vms",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("cloud_account_id", UUID, sa.ForeignKey("cloud_accounts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("cloud_ref", sa.String(500), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("computer_name", sa.String(255)),
        sa.Column("ip_address", sa.String(64)),
        sa.Column("os_type", sa.String(20), nullable=False, server_default="linux"),
        sa.Column("resource_group", sa.String(255)),
        sa.Column("location", sa.String(64)),
        sa.Column("power_state", sa.String(32)),
        sa.Column("tags", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("first_seen", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_seen", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("cloud_ref", name="uq_cloud_pending_ref"),
    )
    op.create_index("ix_cloud_pending_vms_cloud_account_id", "cloud_pending_vms", ["cloud_account_id"])


def downgrade() -> None:
    op.drop_table("cloud_pending_vms")
    op.drop_column("cloud_accounts", "review_new")
    op.drop_column("access_policies", "expiry_notified_at")
    op.drop_table("login_events")
    op.drop_table("user_devices")
