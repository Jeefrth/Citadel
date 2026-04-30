import uuid
from datetime import datetime

from pydantic import BaseModel

from app.models.base import OSType, ServerStatus


class ServerCreate(BaseModel):
    name: str
    hostname: str
    ip_address: str
    os_type: OSType
    os_version: str | None = None
    ssh_port: int = 22
    winrm_port: int = 5985
    tags: dict | None = None
    credential_id: uuid.UUID | None = None
    group_id: uuid.UUID | None = None
    ssh_username: str | None = None
    cert_auth_enabled: bool = False


class ServerUpdate(BaseModel):
    name: str | None = None
    hostname: str | None = None
    ip_address: str | None = None
    os_type: OSType | None = None
    os_version: str | None = None
    ssh_port: int | None = None
    winrm_port: int | None = None
    tags: dict | None = None
    credential_id: uuid.UUID | None = None
    group_id: uuid.UUID | None = None
    ssh_username: str | None = None
    cert_auth_enabled: bool | None = None


class ServerRead(BaseModel):
    id: uuid.UUID
    name: str
    hostname: str
    ip_address: str
    os_type: OSType
    os_version: str | None
    ssh_port: int
    winrm_port: int
    status: ServerStatus
    last_seen: datetime | None
    tags: dict | None
    credential_id: uuid.UUID | None
    group_id: uuid.UUID | None
    ssh_username: str | None
    cert_auth_enabled: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class ServerGroupCreate(BaseModel):
    name: str
    description: str | None = None


class ServerGroupRead(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    created_at: datetime

    model_config = {"from_attributes": True}
