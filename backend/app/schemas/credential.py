import uuid
from datetime import datetime

from pydantic import BaseModel

from app.models.base import CredentialType


class CredentialCreate(BaseModel):
    name: str
    type: CredentialType
    username: str
    password: str | None = None
    ssh_key: str | None = None
    cert_validity_minutes: int | None = None  # Only for ephemeral_cert


class CredentialRead(BaseModel):
    id: uuid.UUID
    name: str
    type: CredentialType
    username: str
    cert_validity_minutes: int | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class CredentialUpdate(BaseModel):
    name: str | None = None
    username: str | None = None
    password: str | None = None
    ssh_key: str | None = None
    cert_validity_minutes: int | None = None
