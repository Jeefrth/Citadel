"""Sign-in (SaaS phase 3): OIDC identity providers, identities linked to a
person, Citadel sessions."""

import uuid

from sqlalchemy import JSON, Boolean, DateTime, Enum, ForeignKey, LargeBinary, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import UserRole, UUIDMixin

PROVIDER_KINDS = ("entra", "google", "okta", "oidc")


class IdentityProvider(UUIDMixin, Base):
    """An OIDC provider. org_id NULL: platform provider (a button on the sign-in
    page for everyone); otherwise the SSO of one organisation. Not a
    TenantMixin: the sign-in flow reads providers before any organisation is
    known; organisation endpoints filter org_id explicitly."""
    __tablename__ = "identity_providers"

    org_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"),
                                                     nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(20), nullable=False, default="oidc")
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    issuer: Mapped[str] = mapped_column(String(500), nullable=False)
    client_id: Mapped[str] = mapped_column(String(255), nullable=False)
    # encrypted with the organisation's key (platform: default key); None = public client (PKCE only)
    encrypted_client_secret: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    scopes: Mapped[str] = mapped_column(String(500), nullable=False, default="openid email profile")
    # e-mail domains of the organisation: discovery from an address, and only these addresses accepted
    domains: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    # arrival without invitation (JIT): None = invitation required
    jit_role: Mapped[UserRole | None] = mapped_column(Enum(UserRole, name="userrole", create_type=False), nullable=True)
    enforced: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)   # members must sign in through it
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class UserIdentity(UUIDMixin, Base):
    """An account at a provider, linked to a Citadel person. Entra: subject = oid
    (its OIDC sub differs per application)."""
    __tablename__ = "user_identities"
    __table_args__ = (UniqueConstraint("issuer", "subject", name="uq_identity_issuer_subject"),)

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    provider_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("identity_providers.id", ondelete="SET NULL"),
                                                          nullable=True, index=True)
    issuer: Mapped[str] = mapped_column(String(500), nullable=False)
    subject: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    email_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_login_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    provider = relationship("IdentityProvider", lazy="joined")


class AuthSession(UUIDMixin, Base):
    """A Citadel session: short access tokens are minted from it with the
    refresh cookie, rotated on every use (reuse of an old one revokes it)."""
    __tablename__ = "auth_sessions"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    provider_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("identity_providers.id", ondelete="SET NULL"),
                                                          nullable=True)
    refresh_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    previous_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)   # reuse detection
    auth_time: Mapped[DateTime] = mapped_column(DateTime(timezone=True), nullable=False)   # last interactive sign-in
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_used_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expires_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(500), nullable=True)
