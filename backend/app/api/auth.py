from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user, user_orgs
from app.core.database import get_db
from app.models.user import User
from app.schemas.user import MeRead, OrgRef

router = APIRouter()


@router.get("/me", response_model=MeRead)
async def get_me(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """The current user, their role in the current organisation and the
    organisations they can switch to (X-Citadel-Org header)."""
    orgs = [OrgRef(id=o.id, name=o.name, slug=o.slug, is_default=o.is_default, role=m.role if m else None)
            for o, m in await user_orgs(db, user)]
    me = MeRead.model_validate(user)
    me.is_platform_admin = user.is_platform_admin
    me.org = next((o for o in orgs if o.id == user.org_id), None)
    me.orgs = orgs
    return me
