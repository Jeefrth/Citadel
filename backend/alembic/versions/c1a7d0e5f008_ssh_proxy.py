"""Lot 7: SSH proxy (user public keys, connection tokens).

Revision ID: c1a7d0e5f008
Revises: c1a7d0e5f007
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c1a7d0e5f008"
down_revision: Union[str, None] = "c1a7d0e5f007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        "user_ssh_keys",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("public_key", sa.String(16000), nullable=False),
        sa.Column("fingerprint", sa.String(128), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_user_ssh_keys_user_id", "user_ssh_keys", ["user_id"])
    op.create_table(
        "ssh_connect_tokens",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True)),
        sa.Column("revoked", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_ssh_connect_tokens_user_id", "ssh_connect_tokens", ["user_id"])


def downgrade() -> None:
    op.drop_table("ssh_connect_tokens")
    op.drop_table("user_ssh_keys")
