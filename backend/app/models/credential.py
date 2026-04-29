from sqlalchemy import String, Integer, Enum, LargeBinary
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import UUIDMixin, TimestampMixin, CredentialType


class Credential(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "credentials"

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    type: Mapped[CredentialType] = mapped_column(
        Enum(CredentialType), nullable=False
    )
    username: Mapped[str] = mapped_column(String(255), nullable=False)
    encrypted_password: Mapped[bytes | None] = mapped_column(
        LargeBinary, nullable=True
    )
    encrypted_ssh_key: Mapped[bytes | None] = mapped_column(
        LargeBinary, nullable=True
    )
    # Only for ephemeral_cert: certificate validity in minutes
    cert_validity_minutes: Mapped[int | None] = mapped_column(
        Integer, nullable=True, default=480
    )

    servers = relationship("Server", back_populates="credential")
