"""Job launcher IP, so connection and command ACLs see the real source IP.

Revision ID: c1a7d0e5f006
Revises: c1a7d0e5f005
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c1a7d0e5f006"
down_revision: Union[str, None] = "c1a7d0e5f005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("jobs", sa.Column("client_ip", sa.String(64), nullable=True))


def downgrade() -> None:
    op.drop_column("jobs", "client_ip")
