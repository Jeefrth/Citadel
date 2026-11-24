"""PAM core: nodes, accounts, user groups, access policies, favourites, access keys

- server_groups become root nodes (same ids), servers.group_id -> servers.node_id
- servers.credential_id / ssh_username / cert_auth_enabled become a default Account
- new servers.rdp_port

Revision ID: c1a7d0e5f001
Revises: 9a9138065c97
Create Date: 2026-11-24 18:30:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c1a7d0e5f001"
down_revision: Union[str, None] = "9a9138065c97"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)
JSONB = postgresql.JSONB


def _ts():
    return sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False)


def upgrade() -> None:
    # ── New tables ──
    op.create_table(
        "nodes",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("parent_id", UUID, sa.ForeignKey("nodes.id", ondelete="CASCADE"), nullable=True),
        sa.Column("description", sa.String(500), nullable=True),
        _ts(),
        sa.UniqueConstraint("parent_id", "name", name="uq_node_parent_name"),
    )
    op.create_index("ix_nodes_parent_id", "nodes", ["parent_id"])

    op.create_table(
        "accounts",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("server_id", UUID, sa.ForeignKey("servers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("username", sa.String(255), nullable=False),
        sa.Column("credential_id", UUID, sa.ForeignKey("credentials.id", ondelete="SET NULL"), nullable=True),
        sa.Column("use_cert", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("privileged", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("is_default", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("description", sa.String(500), nullable=True),
        _ts(),
        sa.UniqueConstraint("server_id", "username", name="uq_account_server_username"),
    )
    op.create_index("ix_accounts_server_id", "accounts", ["server_id"])

    op.create_table(
        "user_groups",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("name", sa.String(255), nullable=False, unique=True),
        sa.Column("description", sa.String(500), nullable=True),
        _ts(),
    )
    op.create_table(
        "user_group_members",
        sa.Column("group_id", UUID, sa.ForeignKey("user_groups.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    )

    op.create_table(
        "access_policies",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("name", sa.String(255), nullable=False, unique=True),
        sa.Column("description", sa.String(500), nullable=True),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("valid_from", sa.DateTime(timezone=True), nullable=True),
        sa.Column("valid_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("actions", JSONB, nullable=False, server_default=sa.text("'[\"connect\"]'::jsonb")),
        sa.Column("accounts", JSONB, nullable=False, server_default=sa.text("'[\"@ALL\"]'::jsonb")),
        sa.Column("labels", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("created_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        _ts(),
    )
    for table, col, target in [
        ("policy_users", "user_id", "users.id"),
        ("policy_groups", "group_id", "user_groups.id"),
        ("policy_servers", "server_id", "servers.id"),
        ("policy_nodes", "node_id", "nodes.id"),
    ]:
        op.create_table(
            table,
            sa.Column("policy_id", UUID, sa.ForeignKey("access_policies.id", ondelete="CASCADE"), primary_key=True),
            sa.Column(col, UUID, sa.ForeignKey(target, ondelete="CASCADE"), primary_key=True),
        )

    op.create_table(
        "user_favorites",
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("server_id", UUID, sa.ForeignKey("servers.id", ondelete="CASCADE"), primary_key=True),
        _ts(),
    )

    op.create_table(
        "access_keys",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("prefix", sa.String(16), nullable=False, unique=True),
        sa.Column("key_hash", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.text("true")),
        _ts(),
    )
    op.create_index("ix_access_keys_user_id", "access_keys", ["user_id"])
    op.create_index("ix_access_keys_prefix", "access_keys", ["prefix"])

    # ── servers: new columns ──
    op.add_column("servers", sa.Column("rdp_port", sa.Integer, nullable=False, server_default="3389"))
    op.add_column("servers", sa.Column("node_id", UUID, nullable=True))
    op.create_foreign_key("servers_node_id_fkey", "servers", "nodes", ["node_id"], ["id"], ondelete="SET NULL")
    op.create_index("ix_servers_node_id", "servers", ["node_id"])

    # ── Data migration ──
    op.execute("""
        INSERT INTO nodes (id, name, parent_id, description, created_at)
        SELECT id, name, NULL, description, created_at FROM server_groups
    """)
    op.execute("UPDATE servers SET node_id = group_id WHERE group_id IS NOT NULL")
    # Default account from the server's credential (username comes from the credential)
    op.execute("""
        INSERT INTO accounts (id, server_id, username, credential_id, use_cert, privileged, is_default, is_active, created_at)
        SELECT gen_random_uuid(), s.id, c.username, c.id, false, true, true, true, now()
        FROM servers s JOIN credentials c ON c.id = s.credential_id
    """)
    # Cert-only servers: ephemeral certificate with ssh_username
    op.execute("""
        INSERT INTO accounts (id, server_id, username, credential_id, use_cert, privileged, is_default, is_active, created_at)
        SELECT gen_random_uuid(), s.id, s.ssh_username, NULL, true, true, true, true, now()
        FROM servers s
        WHERE s.credential_id IS NULL AND s.cert_auth_enabled AND s.ssh_username IS NOT NULL
    """)
    # Servers that had both: also expose the cert account (non default)
    op.execute("""
        INSERT INTO accounts (id, server_id, username, credential_id, use_cert, privileged, is_default, is_active, created_at)
        SELECT gen_random_uuid(), s.id, s.ssh_username, NULL, true, false, false, true, now()
        FROM servers s JOIN credentials c ON c.id = s.credential_id
        WHERE s.cert_auth_enabled AND s.ssh_username IS NOT NULL AND s.ssh_username <> c.username
    """)

    # ── servers: drop legacy columns ──
    op.drop_constraint("servers_group_id_fkey", "servers", type_="foreignkey")
    op.drop_constraint("servers_credential_id_fkey", "servers", type_="foreignkey")
    op.drop_column("servers", "group_id")
    op.drop_column("servers", "credential_id")
    op.drop_column("servers", "ssh_username")
    op.drop_column("servers", "cert_auth_enabled")
    op.drop_table("server_groups")


def downgrade() -> None:
    op.create_table(
        "server_groups",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("name", sa.String(255), nullable=False, unique=True),
        sa.Column("description", sa.String(500), nullable=True),
        _ts(),
    )
    op.add_column("servers", sa.Column("group_id", UUID, sa.ForeignKey("server_groups.id", name="servers_group_id_fkey"), nullable=True))
    op.add_column("servers", sa.Column("credential_id", UUID, sa.ForeignKey("credentials.id", name="servers_credential_id_fkey"), nullable=True))
    op.add_column("servers", sa.Column("ssh_username", sa.String(255), nullable=True))
    op.add_column("servers", sa.Column("cert_auth_enabled", sa.Boolean, nullable=False, server_default=sa.text("false")))

    # Root nodes back to groups; default accounts back to server columns
    op.execute("""
        INSERT INTO server_groups (id, name, description, created_at)
        SELECT id, name, description, created_at FROM nodes WHERE parent_id IS NULL
    """)
    op.execute("""
        UPDATE servers s SET group_id = s.node_id
        WHERE s.node_id IN (SELECT id FROM server_groups)
    """)
    op.execute("""
        UPDATE servers s SET credential_id = a.credential_id,
            ssh_username = a.username, cert_auth_enabled = a.use_cert
        FROM accounts a WHERE a.server_id = s.id AND a.is_default
    """)

    op.drop_index("ix_servers_node_id", "servers")
    op.drop_constraint("servers_node_id_fkey", "servers", type_="foreignkey")
    op.drop_column("servers", "node_id")
    op.drop_column("servers", "rdp_port")
    for t in ["access_keys", "user_favorites", "policy_nodes", "policy_servers", "policy_groups",
              "policy_users", "access_policies", "user_group_members", "user_groups", "accounts", "nodes"]:
        op.drop_table(t)
