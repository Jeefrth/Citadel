"""PAM administration: nodes (A1), user groups, access policies (C1),
personal access keys (F4) and the current user's effective access."""

import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user, hash_access_key, require_role, ACCESS_KEY_PREFIX, has_perm, require_perm
from app.core.database import get_db
from app.core.permissions import compute_grants, node_descendants
from app.models.audit import AuditLog
from app.models.base import UserRole
from app.models.pam import AccessKey, AccessPolicy, Node, UserGroup
from app.models.server import Server
from app.models.user import User
from app.services import policy_io
from app.schemas.pam import (
    AccessKeyCreate, AccessKeyCreated, AccessKeyRead,
    AccessPolicyCreate, AccessPolicyRead, AccessPolicyUpdate,
    MyServerAccess, NodeCreate, NodeRead, NodeUpdate, Ref,
    UserGroupCreate, UserGroupRead, UserGroupUpdate,
)

router = APIRouter()
admin_only = require_role(UserRole.ADMIN)


async def _load_many(db: AsyncSession, model, ids: list[uuid.UUID], label: str):
    if not ids:
        return []
    rows = (await db.execute(select(model).where(model.id.in_(ids)))).scalars().all()
    if len(rows) != len(set(ids)):
        raise HTTPException(status_code=400, detail=f"Unknown {label} in request")
    return list(rows)


# ── Nodes ────────────────────────────────────────────────


async def _nodes_read(db: AsyncSession, user: User) -> list[NodeRead]:
    nodes = (await db.execute(select(Node).order_by(Node.name))).scalars().all()
    by_id = {n.id: n for n in nodes}

    def path(n: Node, depth: int = 0) -> str:
        parent = by_id.get(n.parent_id) if n.parent_id else None
        return n.name if parent is None or depth > 50 else f"{path(parent, depth + 1)}/{n.name}"

    grants = await compute_grants(db, user)
    q = select(Server.node_id, func.count()).group_by(Server.node_id)
    if grants is not None:
        q = q.where(Server.id.in_(list(grants.keys()) or [uuid.uuid4()]))
    counts = {r[0]: r[1] for r in (await db.execute(q)).all()}

    out = [
        NodeRead(id=n.id, name=n.name, parent_id=n.parent_id, description=n.description,
                 path=path(n), server_count=counts.get(n.id, 0))
        for n in nodes
    ]
    if grants is not None:
        # Non-admins only see branches leading to a server they can access
        keep: set[uuid.UUID] = set()
        for n in nodes:
            if counts.get(n.id):
                cur = n
                while cur is not None and cur.id not in keep:
                    keep.add(cur.id)
                    cur = by_id.get(cur.parent_id) if cur.parent_id else None
        out = [n for n in out if n.id in keep]
    return sorted(out, key=lambda n: n.path.lower())


@router.get("/nodes", response_model=list[NodeRead])
async def list_nodes(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    return await _nodes_read(db, user)


async def _check_parent(db: AsyncSession, node_id: uuid.UUID | None, parent_id: uuid.UUID | None):
    if parent_id is None:
        return
    if not await db.get(Node, parent_id):
        raise HTTPException(status_code=400, detail="Parent node not found")
    if node_id is not None:
        pairs = [(r[0], r[1]) for r in (await db.execute(select(Node.id, Node.parent_id))).all()]
        if parent_id in node_descendants(pairs, {node_id}):
            raise HTTPException(status_code=400, detail="A node cannot be moved under itself")


@router.post("/nodes", response_model=NodeRead, status_code=status.HTTP_201_CREATED)
async def create_node(data: NodeCreate, db: AsyncSession = Depends(get_db), user: User = Depends(require_perm("servers"))):
    await _check_parent(db, None, data.parent_id)
    node = Node(**data.model_dump())
    db.add(node)
    db.add(AuditLog(user_id=user.id, action="node.create", result=data.name))
    await db.commit()
    return next(n for n in await _nodes_read(db, user) if n.id == node.id)


@router.patch("/nodes/{node_id}", response_model=NodeRead)
async def update_node(
    node_id: uuid.UUID, data: NodeUpdate, db: AsyncSession = Depends(get_db), user: User = Depends(require_perm("servers")),
):
    node = await db.get(Node, node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    changes = data.model_dump(exclude_unset=True)
    if "parent_id" in changes:
        await _check_parent(db, node_id, changes["parent_id"])
    for k, v in changes.items():
        setattr(node, k, v)
    db.add(AuditLog(user_id=user.id, action="node.update", result=node.name))
    await db.commit()
    return next(n for n in await _nodes_read(db, user) if n.id == node.id)


@router.delete("/nodes/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_node(node_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_perm("servers"))):
    """Delete a node and its sub-nodes; their servers are moved to the root."""
    node = await db.get(Node, node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    db.add(AuditLog(user_id=user.id, action="node.delete", result=node.name))
    await db.delete(node)
    await db.commit()


# ── User groups ──────────────────────────────────────────


@router.get("/user-groups", response_model=list[UserGroupRead])
async def list_groups(db: AsyncSession = Depends(get_db), _: User = Depends(require_perm("policies"))):
    return (await db.execute(select(UserGroup).order_by(UserGroup.name))).scalars().all()


@router.post("/user-groups", response_model=UserGroupRead, status_code=status.HTTP_201_CREATED)
async def create_group(data: UserGroupCreate, db: AsyncSession = Depends(get_db), user: User = Depends(require_perm("policies"))):
    if (await db.execute(select(UserGroup).where(UserGroup.name == data.name))).first():
        raise HTTPException(status_code=409, detail="Group name already exists")
    group = UserGroup(name=data.name, description=data.description)
    group.users = await _load_many(db, User, data.user_ids, "users")
    db.add(group)
    db.add(AuditLog(user_id=user.id, action="user_group.create", result=data.name))
    await db.commit()
    await db.refresh(group)
    return group


@router.patch("/user-groups/{group_id}", response_model=UserGroupRead)
async def update_group(
    group_id: uuid.UUID, data: UserGroupUpdate, db: AsyncSession = Depends(get_db), user: User = Depends(require_perm("policies")),
):
    group = await db.get(UserGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    if data.name is not None:
        group.name = data.name
    if data.description is not None:
        group.description = data.description
    if data.user_ids is not None:
        group.users = await _load_many(db, User, data.user_ids, "users")
    db.add(AuditLog(user_id=user.id, action="user_group.update", result=group.name))
    await db.commit()
    await db.refresh(group)
    return group


@router.delete("/user-groups/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_group(group_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_perm("policies"))):
    group = await db.get(UserGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    db.add(AuditLog(user_id=user.id, action="user_group.delete", result=group.name))
    await db.delete(group)
    await db.commit()


# ── Access policies ──────────────────────────────────────


def _policy_read(p: AccessPolicy) -> AccessPolicyRead:
    return AccessPolicyRead(
        id=p.id, name=p.name, description=p.description, is_active=p.is_active,
        valid_from=p.valid_from, valid_until=p.valid_until,
        actions=p.actions or [], accounts=p.accounts or [], labels=p.labels or [],
        users=[Ref(id=u.id, name=u.display_name) for u in p.users],
        groups=[Ref(id=g.id, name=g.name) for g in p.groups],
        servers=[Ref(id=s.id, name=s.name) for s in p.servers],
        nodes=[Ref(id=n.id, name=n.name) for n in p.nodes],
        created_at=p.created_at,
    )


async def _apply_policy_targets(db: AsyncSession, policy: AccessPolicy, data) -> None:
    if data.user_ids is not None:
        policy.users = await _load_many(db, User, data.user_ids, "users")
    if data.group_ids is not None:
        policy.groups = await _load_many(db, UserGroup, data.group_ids, "user groups")
    if data.server_ids is not None:
        policy.servers = await _load_many(db, Server, data.server_ids, "servers")
    if data.node_ids is not None:
        policy.nodes = await _load_many(db, Node, data.node_ids, "nodes")


def _check_validity(valid_from, valid_until):
    if valid_from and valid_until and valid_until <= valid_from:
        raise HTTPException(status_code=400, detail="valid_until must be after valid_from")


@router.get("/access-policies", response_model=list[AccessPolicyRead])
async def list_policies(db: AsyncSession = Depends(get_db), _: User = Depends(require_perm("policies"))):
    rows = (await db.execute(select(AccessPolicy).order_by(AccessPolicy.name))).scalars().all()
    return [_policy_read(p) for p in rows]


@router.post("/access-policies", response_model=AccessPolicyRead, status_code=status.HTTP_201_CREATED)
async def create_policy(data: AccessPolicyCreate, db: AsyncSession = Depends(get_db), user: User = Depends(require_perm("policies"))):
    if (await db.execute(select(AccessPolicy).where(AccessPolicy.name == data.name))).first():
        raise HTTPException(status_code=409, detail="Policy name already exists")
    _check_validity(data.valid_from, data.valid_until)
    policy = AccessPolicy(
        name=data.name, description=data.description, is_active=data.is_active,
        valid_from=data.valid_from, valid_until=data.valid_until,
        actions=data.actions, accounts=data.accounts, labels=data.labels, created_by=user.id,
    )
    await _apply_policy_targets(db, policy, data)
    db.add(policy)
    db.add(AuditLog(user_id=user.id, action="access_policy.create", result=data.name))
    await db.commit()
    await db.refresh(policy)
    return _policy_read(policy)


@router.patch("/access-policies/{policy_id}", response_model=AccessPolicyRead)
async def update_policy(
    policy_id: uuid.UUID, data: AccessPolicyUpdate, db: AsyncSession = Depends(get_db), user: User = Depends(require_perm("policies")),
):
    policy = await db.get(AccessPolicy, policy_id)
    if not policy:
        raise HTTPException(status_code=404, detail="Policy not found")
    scalars = data.model_dump(exclude_unset=True, exclude={"user_ids", "group_ids", "server_ids", "node_ids"})
    if "valid_until" in scalars and scalars["valid_until"] != policy.valid_until:
        policy.expiry_notified_at = None  # new end date: remind again
    for k, v in scalars.items():
        setattr(policy, k, v)
    _check_validity(policy.valid_from, policy.valid_until)
    await _apply_policy_targets(db, policy, data)
    db.add(AuditLog(user_id=user.id, action="access_policy.update", result=policy.name))
    await db.commit()
    await db.refresh(policy)
    return _policy_read(policy)


@router.get("/access-policies/export")
async def export_policies(db: AsyncSession = Depends(get_db), user: User = Depends(require_perm("policies"))):
    data = await policy_io.export_policies(db)
    db.add(AuditLog(user_id=user.id, action="access_policy.export", result=f"{len(data['policies'])} règle(s)"))
    await db.commit()
    return JSONResponse(data, headers={"Content-Disposition": "attachment; filename=citadel-regles-acces.json"})


class PolicyImportIn(BaseModel):
    payload: dict
    overwrite: bool = False
    dry_run: bool = True


@router.post("/access-policies/import")
async def import_policies(data: PolicyImportIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_perm("policies"))):
    try:
        report = await policy_io.import_policies(db, data.payload, overwrite=data.overwrite,
                                                 dry_run=data.dry_run, actor_id=user.id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not data.dry_run:
        db.add(AuditLog(user_id=user.id, action="access_policy.import",
                        result=f"{len(report['created'])} créée(s), {len(report['updated'])} remplacée(s), "
                               f"{len(report['skipped'])} ignorée(s), {len(report['errors'])} en erreur"))
        await db.commit()
    else:
        await db.rollback()
    return {"dry_run": data.dry_run, **report}


@router.delete("/access-policies/{policy_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_policy(policy_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_perm("policies"))):
    policy = await db.get(AccessPolicy, policy_id)
    if not policy:
        raise HTTPException(status_code=404, detail="Policy not found")
    db.add(AuditLog(user_id=user.id, action="access_policy.delete", result=policy.name))
    await db.delete(policy)
    await db.commit()


@router.get("/users/{user_id}/access", response_model=list[MyServerAccess])
async def user_effective_access(user_id: uuid.UUID, db: AsyncSession = Depends(get_db), _: User = Depends(require_perm("policies"))):
    """Effective access of any user (admin troubleshooting: 'why can X see Y?')."""
    target = await db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    return await _effective_access(db, target)


@router.get("/me/access", response_model=list[MyServerAccess])
async def my_access(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    return await _effective_access(db, user)


async def _effective_access(db: AsyncSession, user: User) -> list[MyServerAccess]:
    grants = await compute_grants(db, user)
    q = select(Server.id, Server.name).order_by(Server.name)
    if grants is not None:
        q = q.where(Server.id.in_(list(grants.keys()) or [uuid.uuid4()]))
    out = []
    for sid, name in (await db.execute(q)).all():
        if grants is None:
            out.append(MyServerAccess(server_id=sid, server_name=name, actions=["*"], accounts=["*"], policies=["admin"]))
        else:
            g = grants[sid]
            out.append(MyServerAccess(server_id=sid, server_name=name, actions=sorted(g.actions),
                                      accounts=sorted(g.accounts), policies=sorted(g.policies)))
    return out


# ── Access keys (F4) ─────────────────────────────────────


def _key_read(k: AccessKey) -> AccessKeyRead:
    return AccessKeyRead(
        id=k.id, name=k.name, prefix=k.prefix, user_id=k.user_id,
        user_name=k.user.display_name if k.user else None,
        created_at=k.created_at, expires_at=k.expires_at,
        last_used_at=k.last_used_at, is_active=k.is_active,
    )


@router.get("/access-keys", response_model=list[AccessKeyRead])
async def list_access_keys(
    all_users: bool = False, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
):
    q = select(AccessKey).order_by(AccessKey.created_at.desc())
    if not (all_users and user.role == UserRole.ADMIN):
        q = q.where(AccessKey.user_id == user.id)
    return [_key_read(k) for k in (await db.execute(q)).scalars().all()]


@router.post("/access-keys", response_model=AccessKeyCreated, status_code=status.HTTP_201_CREATED)
async def create_access_key(data: AccessKeyCreate, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    if getattr(user, "_via_access_key", False):
        raise HTTPException(status_code=403, detail="Access keys cannot create other access keys")
    prefix = secrets.token_hex(6)
    token = f"{ACCESS_KEY_PREFIX}{prefix}_{secrets.token_urlsafe(32)}"
    key = AccessKey(
        user_id=user.id, name=data.name, prefix=prefix, key_hash=hash_access_key(token),
        expires_at=(datetime.now(timezone.utc) + timedelta(days=data.expires_in_days)) if data.expires_in_days else None,
    )
    db.add(key)
    db.add(AuditLog(user_id=user.id, action="access_key.create", result=f"{data.name} ({prefix})"))
    await db.commit()
    key = (await db.execute(select(AccessKey).where(AccessKey.id == key.id))).scalar_one()
    return AccessKeyCreated(**_key_read(key).model_dump(), token=token)


@router.delete("/access-keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_access_key(key_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    key = await db.get(AccessKey, key_id)
    if not key or (key.user_id != user.id and user.role != UserRole.ADMIN):
        raise HTTPException(status_code=404, detail="Access key not found")
    key.is_active = False
    db.add(AuditLog(user_id=user.id, action="access_key.revoke", result=f"{key.name} ({key.prefix})"))
    await db.commit()
