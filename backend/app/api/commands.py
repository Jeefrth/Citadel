import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user, require_role
from app.core.database import get_db
from app.models.user import User
from app.models.audit import AuditLog
from app.models.base import UserRole
from app.core.command_filter import check_command
from app.schemas.command import (
    CommandRequest,
    CommandResponse,
    ConnectionTestResponse,
    SystemInfoResponse,
)
from app.services import connection_manager

router = APIRouter()


@router.post(
    "/{server_id}/test-connection",
    response_model=ConnectionTestResponse,
)
async def test_connection(
    server_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Test SSH or WinRM connectivity to a server."""
    try:
        result = await connection_manager.test_connection(str(server_id), db)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))

    db.add(AuditLog(
        user_id=user.id,
        server_id=server_id,
        action="server.test_connection",
        status="success" if result.success else "failure",
        result=result.message,
    ))
    await db.commit()

    return result


@router.post(
    "/{server_id}/execute",
    response_model=CommandResponse,
)
async def execute_command(
    server_id: uuid.UUID,
    body: CommandRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN, UserRole.OPERATOR)),
):
    """Execute a command on a remote server (SSH or PowerShell)."""
    # Security: block dangerous commands (reads patterns from DB)
    allowed, reason = await check_command(body.command, db)
    if not allowed:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=reason)

    try:
        result = await connection_manager.execute_command(
            str(server_id), body.command, db, timeout=body.timeout
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Command execution failed: {e}",
        )

    db.add(AuditLog(
        user_id=user.id,
        server_id=server_id,
        action="server.execute_command",
        command=body.command,
        status="success" if result.exit_code == 0 else "failure",
        result=result.stdout[:500] if result.stdout else result.stderr[:500],
        ip_address=request.client.host if request.client else None,
    ))
    await db.commit()

    return result


@router.get(
    "/{server_id}/info",
    response_model=SystemInfoResponse,
)
async def get_system_info(
    server_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Retrieve system information from a remote server."""
    try:
        info = await connection_manager.get_system_info(str(server_id), db)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to retrieve system info: {e}",
        )

    return info
