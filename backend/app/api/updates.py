import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user, require_role
from app.core.database import get_db
from app.models.user import User
from app.models.server import Server
from app.core.permissions import (
    ResolvedAccount, default_account, require_server, visible_server_ids,
)
from app.models.pam import PolicyAction
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
from app.services import routing, update_service

router = APIRouter()


def _password_account(account: ResolvedAccount) -> ResolvedAccount:
    if account.use_cert:
        raise HTTPException(
            status_code=400,
            detail="Update management needs a password or SSH key account (ephemeral cert not supported yet)",
        )
    return account


@router.get("/{server_id}/updates", response_model=UpdateScanResponse)
async def scan_updates(
    server_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Scan a server for available updates (default account)."""
    server, _ = await require_server(db, user, server_id)
    credential = _password_account(default_account(server))

    port = server.ssh_port if server.os_type == OSType.LINUX else server.winrm_port

    async with routing.via(server):
        if server.os_type == OSType.LINUX:
            result = await update_service.scan_linux_updates(
                server_id=str(server.id), host=server.ip_address, port=port,
                username=credential.username,
                password=credential.password,
                ssh_key=credential.ssh_key,
            )
        else:
            result = await update_service.scan_windows_updates(
                server_id=str(server.id), host=server.ip_address, port=port,
                username=credential.username,
                password=credential.password,
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
    """Apply updates on a server (requires 'execute' and the default account granted)."""
    server, grant = await require_server(db, user, server_id, PolicyAction.EXECUTE.value)
    credential = _password_account(default_account(server))
    if not grant.allows_account(credential.username):
        raise HTTPException(status_code=403, detail=f"Account '{credential.username}' not granted")
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
    async with routing.via(server):
        if server.os_type == OSType.LINUX:
            result = await update_service.apply_linux_updates(
                host=server.ip_address, port=port,
                username=credential.username,
                password=credential.password,
                ssh_key=credential.ssh_key,
                packages=body.packages,
            )
        else:
            result = await update_service.apply_windows_updates(
                host=server.ip_address, port=port,
                username=credential.username,
                password=credential.password,
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
    """List update jobs on servers visible to the user."""
    query = select(UpdateJob).order_by(UpdateJob.created_at.desc()).limit(50)
    visible = await visible_server_ids(db, user)
    if visible is not None:
        query = query.where(UpdateJob.server_id.in_(list(visible) or [uuid.uuid4()]))
    result = await db.execute(query)
    return result.scalars().all()


@router.get("/updates/compliance", response_model=list[ComplianceEntry])
async def get_compliance_report(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get a compliance overview of servers visible to the user."""
    query = select(Server).order_by(Server.name)
    visible = await visible_server_ids(db, user)
    if visible is not None:
        query = query.where(Server.id.in_(list(visible) or [uuid.uuid4()]))
    result = await db.execute(query)
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
