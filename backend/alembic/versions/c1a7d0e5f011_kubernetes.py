"""Lot 8: Kubernetes clusters and access policies.

Revision ID: c1a7d0e5f011
Revises: c1a7d0e5f010
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c1a7d0e5f011"
down_revision: Union[str, None] = "c1a7d0e5f010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)
JSONB = postgresql.JSONB()


def upgrade() -> None:
    op.create_table(
        "k8s_clusters",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("name", sa.String(255), nullable=False, unique=True),
        sa.Column("description", sa.String(500)),
        sa.Column("api_url", sa.String(500), nullable=False),
        sa.Column("ca_cert", sa.Text()),
        sa.Column("skip_tls_verify", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("encrypted_token", sa.LargeBinary()),
        sa.Column("node_id", UUID, sa.ForeignKey("nodes.id", ondelete="SET NULL")),
        sa.Column("zone_id", UUID, sa.ForeignKey("zones.id", ondelete="SET NULL")),
        sa.Column("tags", JSONB, nullable=False, server_default="{}"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("version", sa.String(50)),
        sa.Column("last_check_at", sa.DateTime(timezone=True)),
        sa.Column("last_check_status", sa.String(20)),
        sa.Column("last_check_message", sa.String(500)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_table(
        "k8s_policies",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("name", sa.String(255), nullable=False, unique=True),
        sa.Column("description", sa.String(500)),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("valid_from", sa.DateTime(timezone=True)),
        sa.Column("valid_until", sa.DateTime(timezone=True)),
        sa.Column("user_ids", JSONB, nullable=False, server_default="[]"),
        sa.Column("group_ids", JSONB, nullable=False, server_default="[]"),
        sa.Column("cluster_ids", JSONB, nullable=False, server_default="[]"),
        sa.Column("namespaces", JSONB, nullable=False, server_default='["*"]'),
        sa.Column("actions", JSONB, nullable=False, server_default='["view", "logs"]'),
        sa.Column("created_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("k8s_policies")
    op.drop_table("k8s_clusters")
