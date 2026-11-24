import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.models.pam import PolicyAction, VIRTUAL_ACCOUNTS


# ── Nodes ──
class NodeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    parent_id: uuid.UUID | None = None
    description: str | None = None


class NodeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    parent_id: uuid.UUID | None = None
    description: str | None = None


class NodeRead(BaseModel):
    id: uuid.UUID
    name: str
    parent_id: uuid.UUID | None
    description: str | None
    path: str
    server_count: int = 0  # direct children servers visible to the user


# ── Accounts ──
class AccountCreate(BaseModel):
    username: str = Field(min_length=1, max_length=255)
    credential_id: uuid.UUID | None = None
    use_cert: bool = False
    privileged: bool = False
    is_default: bool = False
    description: str | None = None


class AccountUpdate(BaseModel):
    username: str | None = Field(default=None, min_length=1, max_length=255)
    credential_id: uuid.UUID | None = None
    use_cert: bool | None = None
    privileged: bool | None = None
    is_default: bool | None = None
    is_active: bool | None = None
    description: str | None = None
    rotation_enabled: bool | None = None
    rotation_interval_days: int | None = Field(default=None, ge=1, le=365)


class AccountRead(BaseModel):
    id: uuid.UUID
    server_id: uuid.UUID
    username: str
    credential_id: uuid.UUID | None
    credential_name: str | None = None
    auth: str
    use_cert: bool
    privileged: bool
    is_default: bool
    is_active: bool
    description: str | None
    created_at: datetime
    rotation_enabled: bool = False
    rotation_interval_days: int = 30
    rotation_supported: bool = False
    rotation_blocker: str | None = None
    last_rotated_at: datetime | None = None
    next_rotation_at: datetime | None = None
    last_rotation_status: str | None = None
    last_rotation_message: str | None = None
    verify_status: str = "unknown"
    verify_message: str | None = None
    last_verified_at: datetime | None = None


class OperationResult(BaseModel):
    ok: bool
    message: str
    account: AccountRead | None = None


class SecretHistoryRead(BaseModel):
    id: uuid.UUID
    status: str
    reason: str
    error: str | None
    actor_id: uuid.UUID | None
    created_at: datetime
    activated_at: datetime | None

    model_config = {"from_attributes": True}


class DiscoveredAccountRead(BaseModel):
    id: uuid.UUID
    server_id: uuid.UUID
    server_name: str | None = None
    username: str
    uid: str | None
    shell: str | None
    enabled: bool | None
    privileged: bool
    last_login: str | None
    status: str          # new | ignored | gone
    managed: bool        # an Account with this username exists on the server
    first_seen: datetime
    last_seen: datetime


class DiscoveredAccountUpdate(BaseModel):
    status: str = Field(pattern="^(new|ignored)$")


class ManageDiscoveredAccount(BaseModel):
    credential_id: uuid.UUID | None = None
    use_cert: bool = False
    privileged: bool | None = None
    rotation_enabled: bool = False


# ── User groups ──
class UserGroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    user_ids: list[uuid.UUID] = Field(default_factory=list)


class UserGroupUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    user_ids: list[uuid.UUID] | None = None


class UserBrief(BaseModel):
    id: uuid.UUID
    display_name: str
    email: str

    model_config = {"from_attributes": True}


class UserGroupRead(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    users: list[UserBrief]
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Access policies ──
def _check_actions(v: list[str]) -> list[str]:
    allowed = {a.value for a in PolicyAction}
    bad = [a for a in v if a not in allowed]
    if bad:
        raise ValueError(f"Unknown actions: {bad}. Allowed: {sorted(allowed)}")
    return sorted(set(v))


def _check_accounts(v: list[str]) -> list[str]:
    bad = [a for a in v if a.startswith("@") and a not in VIRTUAL_ACCOUNTS]
    if bad:
        raise ValueError(f"Unknown virtual accounts: {bad}. Allowed: {sorted(VIRTUAL_ACCOUNTS)}")
    return sorted(set(a.strip() for a in v if a.strip()))


def _check_labels(v: list[str]) -> list[str]:
    for sel in v:
        if not sel.partition("=")[0].strip():
            raise ValueError(f"Invalid label selector '{sel}' (expected key=value or key=)")
    return sorted(set(v))


class AccessPolicyBase(BaseModel):
    description: str | None = None
    is_active: bool = True
    valid_from: datetime | None = None
    valid_until: datetime | None = None
    actions: list[str] = Field(default_factory=lambda: ["connect"])
    accounts: list[str] = Field(default_factory=lambda: ["@ALL"])
    labels: list[str] = Field(default_factory=list)
    user_ids: list[uuid.UUID] = Field(default_factory=list)
    group_ids: list[uuid.UUID] = Field(default_factory=list)
    server_ids: list[uuid.UUID] = Field(default_factory=list)
    node_ids: list[uuid.UUID] = Field(default_factory=list)

    @field_validator("actions")
    @classmethod
    def _v_actions(cls, v):
        return _check_actions(v)

    @field_validator("accounts")
    @classmethod
    def _v_accounts(cls, v):
        return _check_accounts(v)

    @field_validator("labels")
    @classmethod
    def _v_labels(cls, v):
        return _check_labels(v)


class AccessPolicyCreate(AccessPolicyBase):
    name: str = Field(min_length=1, max_length=255)


class AccessPolicyUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    is_active: bool | None = None
    valid_from: datetime | None = None
    valid_until: datetime | None = None
    actions: list[str] | None = None
    accounts: list[str] | None = None
    labels: list[str] | None = None
    user_ids: list[uuid.UUID] | None = None
    group_ids: list[uuid.UUID] | None = None
    server_ids: list[uuid.UUID] | None = None
    node_ids: list[uuid.UUID] | None = None

    @field_validator("actions")
    @classmethod
    def _v_actions(cls, v):
        return v if v is None else _check_actions(v)

    @field_validator("accounts")
    @classmethod
    def _v_accounts(cls, v):
        return v if v is None else _check_accounts(v)

    @field_validator("labels")
    @classmethod
    def _v_labels(cls, v):
        return v if v is None else _check_labels(v)


class Ref(BaseModel):
    id: uuid.UUID
    name: str


class AccessPolicyRead(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    is_active: bool
    valid_from: datetime | None
    valid_until: datetime | None
    actions: list[str]
    accounts: list[str]
    labels: list[str]
    users: list[Ref]
    groups: list[Ref]
    servers: list[Ref]
    nodes: list[Ref]
    created_at: datetime


class MyServerAccess(BaseModel):
    server_id: uuid.UUID
    server_name: str
    actions: list[str]
    accounts: list[str]
    policies: list[str]


# ── Access keys ──
class AccessKeyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    expires_in_days: int | None = Field(default=90, ge=1, le=3650)


class AccessKeyRead(BaseModel):
    id: uuid.UUID
    name: str
    prefix: str
    user_id: uuid.UUID
    user_name: str | None = None
    created_at: datetime
    expires_at: datetime | None
    last_used_at: datetime | None
    is_active: bool


class AccessKeyCreated(AccessKeyRead):
    token: str  # shown once
