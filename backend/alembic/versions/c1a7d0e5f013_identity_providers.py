"""SaaS phase 3: OIDC identity providers, linked identities, Citadel sessions

Revision ID: c1a7d0e5f013
Revises: c1a7d0e5f012
Create Date: 2026-11-25

The Entra tenant Citadel used until now becomes the SSO of the default
organisation (JIT viewer, like the former automatic join); every existing
user gets an identity at that provider (subject = Entra object id).
"""
import os
import uuid
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c1a7d0e5f013"
down_revision: Union[str, None] = "c1a7d0e5f012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

RLS_ROLE = "citadel_rls"


def upgrade() -> None:
    userrole = postgresql.ENUM(name="userrole", create_type=False)
    op.create_table(
        "identity_providers",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True),
        sa.Column("kind", sa.String(20), nullable=False, server_default="oidc"),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("issuer", sa.String(500), nullable=False),
        sa.Column("client_id", sa.String(255), nullable=False),
        sa.Column("encrypted_client_secret", sa.LargeBinary(), nullable=True),
        sa.Column("scopes", sa.String(500), nullable=False, server_default="openid email profile"),
        sa.Column("domains", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("jit_role", userrole, nullable=True),
        sa.Column("enforced", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_identity_providers_org_id", "identity_providers", ["org_id"])

    op.create_table(
        "user_identities",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("provider_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("identity_providers.id", ondelete="SET NULL"), nullable=True),
        sa.Column("issuer", sa.String(500), nullable=False),
        sa.Column("subject", sa.String(255), nullable=False),
        sa.Column("email", sa.String(255), nullable=False, server_default=""),
        sa.Column("email_verified", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("issuer", "subject", name="uq_identity_issuer_subject"),
    )
    op.create_index("ix_user_identities_user_id", "user_identities", ["user_id"])
    op.create_index("ix_user_identities_provider_id", "user_identities", ["provider_id"])

    op.create_table(
        "auth_sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("provider_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("identity_providers.id", ondelete="SET NULL"), nullable=True),
        sa.Column("refresh_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("previous_hash", sa.String(64), nullable=True),
        sa.Column("auth_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ip_address", sa.String(45), nullable=True),
        sa.Column("user_agent", sa.String(500), nullable=True),
    )
    op.create_index("ix_auth_sessions_user_id", "auth_sessions", ["user_id"])
    op.create_index("ix_auth_sessions_previous_hash", "auth_sessions", ["previous_hash"])
    op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON identity_providers, user_identities, auth_sessions TO {RLS_ROLE}")
    # Deleting a person cascades to their devices and nulls their sign-ins through two
    # paths at once: check the device reference at commit, not in the middle
    op.drop_constraint("login_events_device_id_fkey", "login_events", type_="foreignkey")
    op.create_foreign_key("login_events_device_id_fkey", "login_events", "user_devices", ["device_id"], ["id"],
                          ondelete="SET NULL", deferrable=True, initially="DEFERRED")

    # The Entra tenant used so far: SSO of the default organisation
    tenant, client = os.environ.get("AZURE_TENANT_ID", ""), os.environ.get("AZURE_CLIENT_ID", "")
    if tenant and client:
        pid = str(uuid.uuid4())
        issuer = f"https://login.microsoftonline.com/{tenant}/v2.0"
        op.execute(sa.text(
            "INSERT INTO identity_providers (id, org_id, kind, name, issuer, client_id, scopes, domains, jit_role, enforced, is_active) "
            "SELECT CAST(:id AS uuid), o.id, 'entra', 'Microsoft Entra', :iss, :cid, 'openid email profile', '[]', 'VIEWER', false, true "
            "FROM organizations o WHERE o.is_default").bindparams(id=pid, iss=issuer, cid=client))
        op.execute(sa.text(
            "INSERT INTO user_identities (id, user_id, provider_id, issuer, subject, email, email_verified) "
            "SELECT gen_random_uuid(), u.id, CAST(:pid AS uuid), :iss, u.entra_object_id, u.email, false FROM users u "
            "WHERE u.entra_object_id NOT LIKE 'dev-mode%' AND u.entra_object_id NOT LIKE 'lab-%'").bindparams(pid=pid, iss=issuer))
        # discovery from an address: the domains its people already use
        op.execute(sa.text(
            "UPDATE identity_providers SET domains = COALESCE((SELECT json_agg(DISTINCT lower(split_part(email, '@', 2))) "
            "FROM users WHERE email LIKE '%@%' AND entra_object_id NOT LIKE 'lab-%'), '[]'::json) "
            "WHERE id = CAST(:pid AS uuid)").bindparams(pid=pid))


def downgrade() -> None:
    op.drop_constraint("login_events_device_id_fkey", "login_events", type_="foreignkey")
    op.create_foreign_key("login_events_device_id_fkey", "login_events", "user_devices", ["device_id"], ["id"], ondelete="SET NULL")
    op.drop_table("auth_sessions")
    op.drop_table("user_identities")
    op.drop_table("identity_providers")
