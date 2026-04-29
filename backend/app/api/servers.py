import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user, require_role
from app.core.database import get_db
from app.core.security import encrypt_value, decrypt_value
from app.models.user import User
from app.models.server import Server, ServerGroup
from app.models.credential import Credential
from app.models.audit import AuditLog
from app.models.base import UserRole
from app.schemas.server import (
    ServerCreate, ServerUpdate, ServerRead,
    ServerGroupCreate, ServerGroupRead,
)
from app.schemas.credential import CredentialCreate, CredentialRead, CredentialUpdate

router = APIRouter()


# ── Server CRUD ──────────────────────────────────────────


@router.get("/", response_model=list[ServerRead])
async def list_servers(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(Server).order_by(Server.name))
    return result.scalars().all()


@router.post("/", response_model=ServerRead, status_code=status.HTTP_201_CREATED)
async def create_server(
    data: ServerCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN, UserRole.OPERATOR)),
):
    server = Server(**data.model_dump())
    db.add(server)

    db.add(AuditLog(
        user_id=user.id,
        server_id=server.id,
        action="server.create",
    ))

    await db.commit()
    await db.refresh(server)
    return server


@router.get("/{server_id}", response_model=ServerRead)
async def get_server(
    server_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(Server).where(Server.id == server_id))
    server = result.scalar_one_or_none()
    if not server:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Server not found")
    return server


@router.patch("/{server_id}", response_model=ServerRead)
async def update_server(
    server_id: uuid.UUID,
    data: ServerUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN, UserRole.OPERATOR)),
):
    result = await db.execute(select(Server).where(Server.id == server_id))
    server = result.scalar_one_or_none()
    if not server:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Server not found")

    update_data = data.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(server, field, value)

    db.add(AuditLog(
        user_id=user.id,
        server_id=server.id,
        action="server.update",
    ))

    await db.commit()
    await db.refresh(server)
    return server


@router.delete("/{server_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_server(
    server_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    result = await db.execute(select(Server).where(Server.id == server_id))
    server = result.scalar_one_or_none()
    if not server:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Server not found")

    db.add(AuditLog(
        user_id=user.id,
        server_id=server.id,
        action="server.delete",
    ))

    await db.delete(server)
    await db.commit()


# ── Server Groups ────────────────────────────────────────


@router.get("/groups/", response_model=list[ServerGroupRead])
async def list_groups(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(ServerGroup).order_by(ServerGroup.name))
    return result.scalars().all()


@router.post("/groups/", response_model=ServerGroupRead, status_code=status.HTTP_201_CREATED)
async def create_group(
    data: ServerGroupCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN, UserRole.OPERATOR)),
):
    group = ServerGroup(**data.model_dump())
    db.add(group)
    await db.commit()
    await db.refresh(group)
    return group


# ── Credentials (encrypted) ─────────────────────────────


@router.get("/credentials/", response_model=list[CredentialRead])
async def list_credentials(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN, UserRole.OPERATOR)),
):
    result = await db.execute(select(Credential).order_by(Credential.name))
    return result.scalars().all()


@router.post("/credentials/", response_model=CredentialRead, status_code=status.HTTP_201_CREATED)
async def create_credential(
    data: CredentialCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    cred = Credential(
        name=data.name,
        type=data.type,
        username=data.username,
        encrypted_password=encrypt_value(data.password) if data.password else None,
        encrypted_ssh_key=encrypt_value(data.ssh_key) if data.ssh_key else None,
    )
    db.add(cred)

    db.add(AuditLog(
        user_id=user.id,
        action="credential.create",
    ))

    await db.commit()
    await db.refresh(cred)
    return cred


@router.patch("/credentials/{cred_id}", response_model=CredentialRead)
async def update_credential(
    cred_id: uuid.UUID,
    data: CredentialUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    result = await db.execute(select(Credential).where(Credential.id == cred_id))
    cred = result.scalar_one_or_none()
    if not cred:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Credential not found")

    if data.name is not None:
        cred.name = data.name
    if data.username is not None:
        cred.username = data.username
    if data.password is not None:
        cred.encrypted_password = encrypt_value(data.password)
    if data.ssh_key is not None:
        cred.encrypted_ssh_key = encrypt_value(data.ssh_key)

    db.add(AuditLog(
        user_id=user.id,
        action="credential.update",
    ))

    await db.commit()
    await db.refresh(cred)
    return cred


@router.delete("/credentials/{cred_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_credential(
    cred_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.ADMIN)),
):
    result = await db.execute(select(Credential).where(Credential.id == cred_id))
    cred = result.scalar_one_or_none()
    if not cred:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Credential not found")

    db.add(AuditLog(
        user_id=user.id,
        action="credential.delete",
    ))

    await db.delete(cred)
    await db.commit()
