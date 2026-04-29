import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user, require_role
from app.core.database import get_db
from app.models.user import User
from app.models.server import Server
from app.models.credential import Credential
from app.models.update_job import UpdateJob
from app.models.audit import AuditLog
from app.models.base import UserRole, OSType, JobStatus
from app.schemas.update import (
    UpdateScanResponse,
    UpdateApplyRequest,
    UpdateApplyResponse,
    UpdateJobRead,
    ComplianceEntry,
)
from app.services import update_service

router = APIRouter()


async def _get_server_and_cred(
    server_id: uuid.UUID, db: AsyncSession
) -> tuple[Server, Credential]:
    result = await db.execute(select(Server).where(Server.id == server_id))
    server = result.scalar_one_or_none()
    if not server:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Server not found")

    if not server.credential_id:
        raise HTTPException(status_code=400, detail="No credential assigned to this server")

    cred_result = await db.execute(
        select(Credential).where(Credential.id == server.credential_id)
    )
    credential = cred_result.scalar_one_or_none()
    if not credential:
        raise HTTPException(status_code=400, detail="Credential not found")

    return server, credential


@router.get("/{server_id}/updates", response_model=UpdateScanResponse)
async def scan_updates(
    server_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Scan a server for available updates."""
    server, credential = await _get_server_and_cred(server_id, db)

    port = server.ssh_port if server.os_type == OSType.LINUX else server.winrm_port

    if server.os_type == OSType.LINUX:
        result = await update_service.scan_linux_updates(
            server_id=str(server.id), host=server.ip_address, port=port,
            username=credential.username,
            password=credential.encrypted_password,
            ssh_key=credential.encrypted_ssh_key,
        )
    else:
        result = await update_service.scan_windows_updates(
            server_id=str(server.id), host=server.ip_address, port=port,
            username=credential.username,
            password=credential.encrypted_password,
        )

    db.add(AuditLog(
        user_id=user.id, server_id=server.id,
        action="updates.scan",
        result=f"{result.total_updates} updates ({result.security_updates} security)",
    ))
    await db.commit()

    return result


@router.post("/{server_id}/updates/apply", response_model=UpdateApplyResponse)
async def apply_updates(
    server_id: uuid.UUID,
    body: UpdateApplyRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN, UserRole.OPERATOR)),
):
    """Apply updates on a server."""
    server, credential = await _get_server_and_cred(server_id, db)
    port = server.ssh_port if server.os_type == OSType.LINUX else server.winrm_port

    # Create job record
    job = UpdateJob(
        server_id=server.id,
        user_id=user.id,
        type="update_apply",
        packages={"packages": body.packages} if body.packages else None,
        status=JobStatus.RUNNING,
        started_at=datetime.now(timezone.utc),
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    # Execute
    if server.os_type == OSType.LINUX:
        result = await update_service.apply_linux_updates(
            host=server.ip_address, port=port,
            username=credential.username,
            password=credential.encrypted_password,
            ssh_key=credential.encrypted_ssh_key,
            packages=body.packages,
        )
    else:
        result = await update_service.apply_windows_updates(
            host=server.ip_address, port=port,
            username=credential.username,
            password=credential.encrypted_password,
            packages=body.packages,
        )

    # Update job
    job.status = JobStatus.COMPLETED if result.success else JobStatus.FAILED
    job.completed_at = datetime.now(timezone.utc)
    job.output = result.output

    db.add(AuditLog(
        user_id=user.id, server_id=server.id,
        action="updates.apply",
        status="success" if result.success else "failure",
        result=f"{result.packages_updated} packages updated",
    ))
    await db.commit()

    return UpdateApplyResponse(
        job_id=job.id,
        success=result.success,
        packages_updated=result.packages_updated,
        output=result.output,
        error=result.error,
    )


@router.get("/updates/jobs", response_model=list[UpdateJobRead])
async def list_update_jobs(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List all update jobs."""
    result = await db.execute(
        select(UpdateJob).order_by(UpdateJob.created_at.desc()).limit(50)
    )
    return result.scalars().all()


@router.get("/updates/compliance", response_model=list[ComplianceEntry])
async def get_compliance_report(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get a compliance overview of all servers."""
    result = await db.execute(select(Server).order_by(Server.name))
    servers = result.scalars().all()

    entries = []
    for srv in servers:
        entries.append(ComplianceEntry(
            server_id=str(srv.id),
            server_name=srv.name,
            os_type=srv.os_type.value,
            status="unknown",  # Will be enriched when scans are run
            total_updates=0,
            security_updates=0,
        ))

    return entries
