import uuid
from datetime import datetime

from pydantic import BaseModel

from app.models.base import JobStatus


class PackageUpdateRead(BaseModel):
    name: str
    current_version: str
    new_version: str
    severity: str = "unknown"
    size: str = ""


class UpdateScanResponse(BaseModel):
    server_id: str
    os_type: str
    package_manager: str
    total_updates: int
    security_updates: int
    packages: list[PackageUpdateRead]
    error: str | None = None


class UpdateApplyRequest(BaseModel):
    packages: list[str] | None = None  # None = apply all


class UpdateApplyResponse(BaseModel):
    job_id: uuid.UUID
    success: bool
    packages_updated: int
    output: str
    error: str | None = None


class UpdateJobRead(BaseModel):
    id: uuid.UUID
    server_id: uuid.UUID
    user_id: uuid.UUID
    type: str
    packages: dict | None
    status: JobStatus
    scheduled_at: datetime | None
    started_at: datetime | None
    completed_at: datetime | None
    output: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ComplianceEntry(BaseModel):
    server_id: str
    server_name: str
    os_type: str
    status: str  # compliant, updates_available, error, unknown
    total_updates: int
    security_updates: int
