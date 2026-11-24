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


class UserUpdate(BaseModel):
    role: UserRole | None = None
    is_active: bool | None = None
    custom_role_id: uuid.UUID | None = None  # send null to remove
