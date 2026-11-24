import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.models.base import OSType, ServerStatus


class DefaultAccountInput(BaseModel):
    """Convenience: create the default (automation) account with the server."""
    username: str
    credential_id: uuid.UUID | None = None
    use_cert: bool = False
    privileged: bool = True


class ServerCreate(BaseModel):
    name: str
    hostname: str
    ip_address: str
    os_type: OSType
    os_version: str | None = None
    ssh_port: int = 22
    winrm_port: int = 5985
    rdp_port: int = 3389
    tags: dict[str, str] | None = None
    node_id: uuid.UUID | None = None
    default_account: DefaultAccountInput | None = None


class ServerUpdate(BaseModel):
    name: str | None = None
    hostname: str | None = None
    ip_address: str | None = None
    os_type: OSType | None = None
    os_version: str | None = None
    ssh_port: int | None = None
    winrm_port: int | None = None
    rdp_port: int | None = None
    tags: dict[str, str] | None = None
    node_id: uuid.UUID | None = None


class AccountSummary(BaseModel):
    id: uuid.UUID
    username: str
    auth: str  # "password" | "ssh_key" | "cert" | "none"
    privileged: bool
    is_default: bool


class ServerRead(BaseModel):
    id: uuid.UUID
    name: str
    hostname: str
    ip_address: str
    os_type: OSType
    os_version: str | None
    ssh_port: int
    winrm_port: int
    rdp_port: int
    status: ServerStatus
    last_seen: datetime | None
    tags: dict | None
    node_id: uuid.UUID | None
    node_path: str | None = None
    created_at: datetime
    default_account: AccountSummary | None = None
    accounts_count: int = 0
    is_favorite: bool = False
    # Effective rights of the current user on this server
    actions: list[str] = Field(default_factory=list)


class ConnectableAccount(BaseModel):
    id: uuid.UUID | None
    username: str
    privileged: bool
    is_default: bool
    virtual: str | None


class ConnectTicketRequest(BaseModel):
    protocol: str = "rdp"
    account_id: uuid.UUID | None = None
    virtual_account: str | None = None
    input_username: str | None = None
    input_password: str | None = None


class ConnectTicketResponse(BaseModel):
    ticket: str
    expires_in: int
    account: str
