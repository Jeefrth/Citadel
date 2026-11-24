"""Lot 7: custom roles.

Revision ID: c1a7d0e5f010
Revises: c1a7d0e5f009
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c1a7d0e5f010"
down_revision: Union[str, None] = "c1a7d0e5f009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "custom_roles",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False, unique=True),
        sa.Column("description", sa.String(500)),
        sa.Column("permissions", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.add_column("users", sa.Column("custom_role_id", postgresql.UUID(as_uuid=True),
                                     sa.ForeignKey("custom_roles.id", ondelete="SET NULL"), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "custom_role_id")
    op.drop_table("custom_roles")
