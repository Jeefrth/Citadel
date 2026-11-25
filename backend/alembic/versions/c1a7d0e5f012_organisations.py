"""SaaS phase 1: organisations, memberships, org_id on customer tables, row level security

Revision ID: c1a7d0e5f012
Revises: c1a7d0e5f011
Create Date: 2026-11-25

Existing data goes to the organisation "Par défaut" (is_default), which keeps
the current Transit key and SSH CA. users.role / custom_role_id become the
membership of that organisation; former admins become platform admins.
"""
import uuid
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c1a7d0e5f012"
down_revision: Union[str, None] = "c1a7d0e5f011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

RLS_ROLE = "citadel_rls"

TENANT_TABLES = [
    "access_keys", "access_policies", "account_backups", "account_templates", "accounts", "alert_rules",
    "applications", "approval_requests", "audit_logs", "cloud_accounts", "cloud_pending_vms", "command_logs",
    "command_rules", "connection_rules", "credentials", "custom_roles", "discovered_accounts", "gateways",
    "job_targets", "jobs", "k8s_clusters", "k8s_policies", "nodes", "notification_channels", "notifications",
    "playbooks", "recording_storage", "risk_findings", "secret_history", "server_metrics", "servers",
    "session_recordings", "siem_targets", "update_jobs", "user_favorites", "user_groups", "zones",
]
NULLABLE = {"audit_logs"}          # platform events have no organisation

# (table, old global unique constraint, column, new per-org constraint)
UNIQUES = [
    ("servers", "uq_servers_cloud_ref", "cloud_ref", "uq_servers_org_cloud_ref"),
    ("user_groups", "user_groups_name_key", "name", "uq_user_groups_org_name"),
    ("access_policies", "access_policies_name_key", "name", "uq_access_policies_org_name"),
    ("account_templates", "account_templates_name_key", "name", "uq_account_templates_org_name"),
    ("applications", "applications_name_key", "name", "uq_applications_org_name"),
    ("risk_findings", "risk_findings_key_key", "key", "uq_risk_findings_org_key"),
    ("zones", "zones_name_key", "name", "uq_zones_org_name"),
    ("playbooks", "playbooks_name_key", "name", "uq_playbooks_org_name"),
    ("cloud_accounts", "cloud_accounts_name_key", "name", "uq_cloud_accounts_org_name"),
    ("cloud_pending_vms", "uq_cloud_pending_ref", "cloud_ref", "uq_cloud_pending_org_ref"),
    ("siem_targets", "siem_targets_name_key", "name", "uq_siem_targets_org_name"),
    ("k8s_clusters", "k8s_clusters_name_key", "name", "uq_k8s_clusters_org_name"),
    ("k8s_policies", "k8s_policies_name_key", "name", "uq_k8s_policies_org_name"),
    ("custom_roles", "custom_roles_name_key", "name", "uq_custom_roles_org_name"),
    ("connection_rules", "connection_rules_name_key", "name", "uq_connection_rules_org_name"),
    ("command_rules", "command_rules_name_key", "name", "uq_command_rules_org_name"),
    ("notification_channels", "notification_channels_name_key", "name", "uq_notification_channels_org_name"),
]

PLATFORM_SETTINGS = ("_ssh_proxy_host_key",)

POLICY = "(current_setting('app.bypass', true) = 'on' OR org_id::text = current_setting('app.org_id', true))"
SETTINGS_POLICY = ("(current_setting('app.bypass', true) = 'on' OR org_id IS NULL "
                   "OR org_id::text = current_setting('app.org_id', true))")


def upgrade() -> None:
    userrole = postgresql.ENUM(name="userrole", create_type=False)

    op.create_table(
        "organizations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("slug", sa.String(63), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("transit_key", sa.String(100), nullable=True),
        sa.Column("ssh_ca_public", sa.Text(), nullable=True),
        sa.Column("ssh_ca_private", sa.LargeBinary(), nullable=True),
        sa.Column("entra_tenant_id", sa.String(64), nullable=True, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_organizations_slug", "organizations", ["slug"], unique=True)
    # at most one default organisation
    op.create_index("uq_organizations_default", "organizations", ["is_default"], unique=True,
                    postgresql_where=sa.text("is_default"))

    op.create_table(
        "org_memberships",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", userrole, nullable=False, server_default="VIEWER"),
        sa.Column("custom_role_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("custom_roles.id", ondelete="SET NULL"), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("org_id", "user_id", name="uq_membership"),
    )
    op.create_index("ix_org_memberships_org_id", "org_memberships", ["org_id"])
    op.create_index("ix_org_memberships_user_id", "org_memberships", ["user_id"])

    op.create_table(
        "org_invitations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("role", userrole, nullable=False, server_default="VIEWER"),
        sa.Column("invited_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("org_id", "email", name="uq_invitation"),
    )
    op.create_index("ix_org_invitations_org_id", "org_invitations", ["org_id"])
    op.create_index("ix_org_invitations_email", "org_invitations", ["email"])

    # Default organisation = the data that exists today
    default_id = str(uuid.uuid4())
    op.execute(f"INSERT INTO organizations (id, name, slug, is_active, is_default) "
               f"VALUES ('{default_id}', 'Par défaut', 'default', true, true)")

    # Users: platform admin flag, membership from the global role
    op.add_column("users", sa.Column("is_platform_admin", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.execute("UPDATE users SET is_platform_admin = (role = 'ADMIN')")
    op.execute("INSERT INTO org_memberships (id, org_id, user_id, role, custom_role_id, is_active) "
               f"SELECT gen_random_uuid(), '{default_id}', id, role, custom_role_id, true FROM users")
    op.drop_constraint("users_custom_role_id_fkey", "users", type_="foreignkey")
    op.drop_column("users", "custom_role_id")
    op.drop_column("users", "role")

    # org_id on customer tables
    for t in TENANT_TABLES:
        op.add_column(t, sa.Column("org_id", postgresql.UUID(as_uuid=True),
                                   sa.ForeignKey("organizations.id", ondelete="CASCADE", name=f"fk_{t}_org_id"),
                                   nullable=True))
        op.execute(f"UPDATE {t} SET org_id = '{default_id}'")
        if t not in NULLABLE:
            op.alter_column(t, "org_id", nullable=False)
        op.create_index(f"ix_{t}_org_id", t, ["org_id"])

    # Settings: per organisation, platform keys keep org_id NULL
    op.add_column("app_settings", sa.Column("org_id", postgresql.UUID(as_uuid=True),
                                            sa.ForeignKey("organizations.id", ondelete="CASCADE", name="fk_app_settings_org_id"),
                                            nullable=True))
    platform = ", ".join(f"'{k}'" for k in PLATFORM_SETTINGS)
    op.execute(f"UPDATE app_settings SET org_id = '{default_id}' WHERE key NOT IN ({platform})")
    op.drop_index("ix_app_settings_key", "app_settings")
    op.create_index("ix_app_settings_key", "app_settings", ["key"])
    op.create_index("ix_app_settings_org_id", "app_settings", ["org_id"])
    op.execute("ALTER TABLE app_settings ADD CONSTRAINT uq_app_settings_org_key UNIQUE NULLS NOT DISTINCT (org_id, key)")

    # Sign-in journal: organisation for information
    op.add_column("login_events", sa.Column("org_id", postgresql.UUID(as_uuid=True),
                                            sa.ForeignKey("organizations.id", ondelete="SET NULL", name="fk_login_events_org_id"),
                                            nullable=True))
    op.create_index("ix_login_events_org_id", "login_events", ["org_id"])

    # Global uniqueness becomes per organisation
    for table, old, col, new in UNIQUES:
        op.drop_constraint(old, table, type_="unique")
        op.create_unique_constraint(new, table, ["org_id", col])

    # Row level security: the application switches to this role in every transaction
    op.execute(f"""
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{RLS_ROLE}') THEN
                CREATE ROLE {RLS_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
            END IF;
        END $$""")
    op.execute(f"GRANT {RLS_ROLE} TO CURRENT_USER")
    op.execute(f"GRANT USAGE ON SCHEMA public TO {RLS_ROLE}")
    op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {RLS_ROLE}")
    op.execute(f"GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO {RLS_ROLE}")
    op.execute(f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {RLS_ROLE}")
    op.execute(f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO {RLS_ROLE}")
    for t in TENANT_TABLES:
        op.execute(f"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {t} FORCE ROW LEVEL SECURITY")
        op.execute(f"CREATE POLICY org_isolation ON {t} USING {POLICY} WITH CHECK {POLICY}")
    op.execute("ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE app_settings FORCE ROW LEVEL SECURITY")
    op.execute(f"CREATE POLICY org_isolation ON app_settings USING {SETTINGS_POLICY} WITH CHECK {SETTINGS_POLICY}")


def downgrade() -> None:
    """Back to a single organisation: only the default organisation's data is kept."""
    for t in TENANT_TABLES + ["app_settings"]:
        op.execute(f"DROP POLICY IF EXISTS org_isolation ON {t}")
        op.execute(f"ALTER TABLE {t} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {t} DISABLE ROW LEVEL SECURITY")
    op.execute("DELETE FROM organizations WHERE NOT is_default")   # cascades to their rows

    for table, old, col, new in UNIQUES:
        op.drop_constraint(new, table, type_="unique")
        op.create_unique_constraint(old, table, [col])

    op.drop_index("ix_login_events_org_id", "login_events")
    op.drop_column("login_events", "org_id")

    op.execute("ALTER TABLE app_settings DROP CONSTRAINT uq_app_settings_org_key")
    op.drop_index("ix_app_settings_org_id", "app_settings")
    op.drop_index("ix_app_settings_key", "app_settings")
    op.drop_column("app_settings", "org_id")
    op.create_index("ix_app_settings_key", "app_settings", ["key"], unique=True)

    for t in TENANT_TABLES:
        op.drop_index(f"ix_{t}_org_id", t)
        op.drop_column(t, "org_id")

    userrole = postgresql.ENUM(name="userrole", create_type=False)
    op.add_column("users", sa.Column("role", userrole, nullable=False, server_default="VIEWER"))
    op.add_column("users", sa.Column("custom_role_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key("users_custom_role_id_fkey", "users", "custom_roles", ["custom_role_id"], ["id"], ondelete="SET NULL")
    op.execute("UPDATE users u SET role = m.role, custom_role_id = m.custom_role_id "
               "FROM org_memberships m JOIN organizations o ON o.id = m.org_id AND o.is_default WHERE m.user_id = u.id")
    op.execute("UPDATE users SET role = 'ADMIN' WHERE is_platform_admin")
    op.drop_column("users", "is_platform_admin")

    op.drop_table("org_invitations")
    op.drop_table("org_memberships")
    op.drop_table("organizations")
    op.execute(f"REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {RLS_ROLE}")
    op.execute(f"REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM {RLS_ROLE}")
    op.execute(f"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM {RLS_ROLE}")
    op.execute(f"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM {RLS_ROLE}")
    op.execute(f"REVOKE USAGE ON SCHEMA public FROM {RLS_ROLE}")
