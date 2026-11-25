import uuid
from datetime import datetime

from pydantic import BaseModel

from app.models.base import UserRole


class UserRead(BaseModel):
    id: uuid.UUID
    entra_object_id: str
    email: str
    display_name: str
    role: UserRole
    is_active: bool
    created_at: datetime
    last_login: datetime | None
    custom_role_id: uuid.UUID | None = None
    custom_role_name: str | None = None
    permissions: list[str] = []

    model_config = {"from_attributes": True}


class OrgRef(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    is_default: bool = False
    role: UserRole | None = None   # None: platform admin without membership

    model_config = {"from_attributes": True}


class MeRead(UserRead):
    is_platform_admin: bool = False
    org: OrgRef | None = None
    orgs: list[OrgRef] = []
    pending_invitations: int = 0


class UserUpdate(BaseModel):
    role: UserRole | None = None
    is_active: bool | None = None
    custom_role_id: uuid.UUID | None = None  # send null to remove
