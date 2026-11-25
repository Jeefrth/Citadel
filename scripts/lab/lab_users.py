"""Create (or remove with --down) lab users with access keys, for permission tests via the API.
Run inside the backend container: python /tmp/lab_users.py [--down]"""
import asyncio
import secrets
import sys

sys.path.insert(0, "/app")
from sqlalchemy import delete, select, text  # noqa: E402

from app.core import tenancy  # noqa: E402
from app.core.auth import hash_access_key  # noqa: E402
from app.core.database import async_session  # noqa: E402
from app.models.organization import Organization, OrgMembership  # noqa: E402
from app.models.base import UserRole  # noqa: E402
from app.models.identity import CustomRole  # noqa: E402
from app.models.pam import AccessKey  # noqa: E402
from app.models.user import User  # noqa: E402

USERS = [("lab-operator", "Lab Operator", UserRole.OPERATOR, None),
         ("lab-viewer", "Lab Viewer", UserRole.VIEWER, None),
         ("lab-auditor", "Lab Auditeur (rôle personnalisé)", UserRole.VIEWER, "Lab auditeur")]


async def _default_org():
    async with async_session() as db:
        return (await db.execute(select(Organization).where(Organization.is_default.is_(True)))).scalar_one()


async def up():
    """Lab people are members of the default organisation (keys pinned to it)."""
    org = await _default_org()
    with tenancy.tenant(org):
        await _up(org)


async def _up(org):
    async with async_session() as db:
        role = (await db.execute(select(CustomRole).where(CustomRole.name == "Lab auditeur"))).scalar_one_or_none()
        if role is None:
            role = CustomRole(name="Lab auditeur", description="Rôle de test (lab)", permissions=["audit"])
            db.add(role)
            await db.flush()
        for oid, name, r, custom in USERS:
            u = (await db.execute(select(User).where(User.entra_object_id == oid))).scalar_one_or_none()
            if u is None:
                u = User(entra_object_id=oid, email=f"{oid}@lab.test", display_name=name, is_active=True)
                db.add(u)
                await db.flush()
            m = (await db.execute(select(OrgMembership).where(OrgMembership.org_id == org.id,
                                                              OrgMembership.user_id == u.id))).scalar_one_or_none()
            if m is None:
                m = OrgMembership(org_id=org.id, user_id=u.id, role=r)
                db.add(m)
            m.role, m.custom_role_id = r, (role.id if custom else None)
            await db.execute(delete(AccessKey).where(AccessKey.user_id == u.id, AccessKey.name == "lab"))
            prefix = secrets.token_hex(4)
            key = f"ctk_{prefix}_{secrets.token_urlsafe(24)}"
            db.add(AccessKey(user_id=u.id, name="lab", prefix=prefix, key_hash=hash_access_key(key), is_active=True))
            print(f"{oid}\t{r.value}{' + Lab auditeur' if custom else ''}\t{key}")
        await db.commit()


async def down():
    with tenancy.system():
        await _down()


async def _down():
    async with async_session() as db:
        ids = [r[0] for r in (await db.execute(select(User.id).where(User.entra_object_id.like("lab-%")))).all()]
        for t in ("audit_logs", "command_logs", "login_events", "user_devices", "session_recordings"):
            await db.execute(text(f"delete from {t} where user_id = any(:ids)"), {"ids": ids})
        await db.execute(delete(User).where(User.id.in_(ids)))
        await db.execute(delete(CustomRole).where(CustomRole.name == "Lab auditeur"))
        await db.commit()
        print(f"{len(ids)} lab user(s) removed")


asyncio.run(down() if "--down" in sys.argv else up())
