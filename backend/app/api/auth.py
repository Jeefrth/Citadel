from fastapi import APIRouter, Depends

from app.core.auth import get_current_user
from app.models.user import User
from app.schemas.user import UserRead

router = APIRouter()


@router.get("/me", response_model=UserRead)
async def get_me(user: User = Depends(get_current_user)):
    """Return the currently authenticated user profile."""
    return user
