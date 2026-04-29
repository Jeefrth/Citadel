from fastapi import APIRouter, Depends, Query
from fastapi.responses import PlainTextResponse

from app.core.auth import get_current_user, require_role
from app.models.user import User
from app.models.base import UserRole
from app.services import ca_service

router = APIRouter()


@router.get("/public-key", response_class=PlainTextResponse)
async def get_ca_public_key(
    user: User = Depends(get_current_user),
):
    """Get the CA public key to configure on target servers."""
    return ca_service.get_ca_public_key()


@router.get("/setup-instructions", response_class=PlainTextResponse)
async def get_setup_instructions(
    hostname: str = Query(default="my-server"),
    user: User = Depends(require_role(UserRole.ADMIN, UserRole.OPERATOR)),
):
    """Get shell commands to configure a server to trust this CA."""
    return ca_service.get_setup_instructions(hostname)
