"""Operations API (lot 5): web file transfers (E1), jobs & playbooks (E2/E3),
zones & gateways (A4), cloud accounts (A8)."""

import hashlib
import posixpath
import stat
import uuid
from datetime import datetime

import anyio
import yaml
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user, require_role
from app.core.database import async_session, get_db
from app.core.permissions import require_server, resolve_for_user
from app.core.security import encrypt_value
from app.models.audit import AuditLog
from app.models.base import OSType, UserRole
from app.models.credential import Credential
from app.models.operations import CloudAccount, Gateway, Job, Playbook, Zone
from app.models.pam import Node, PolicyAction
from app.models.user import User
from app.services import cloud_sync, jobs as jobs_svc, routing, sftp
from app.services.enforcement import GovernanceDenied, enforce_connect
from app.services.settings_service import get_setting_int

router = APIRouter()
admin_only = require_role(UserRole.ADMIN)


# ── Files (E1) ───────────────────────────────────────────


async def _file_context(db, user, request, server_id, action, account_id, virtual_account):
    server, grant = await require_server(db, user, server_id)
    if server.os_type != OSType.LINUX:
        raise HTTPException(status_code=400, detail="File transfer is available for Linux servers (SFTP)")
    if action not in grant.actions:
        raise HTTPException(status_code=403, detail=f"Action '{action}' not granted on this server")
    if virtual_account == "@INPUT":
        raise HTTPException(status_code=400, detail="@INPUT accounts cannot be used for file transfers")
    account = resolve_for_user(server, grant, user, account_id=account_id, virtual=virtual_account)
    try:
        await enforce_connect(db, user, server, account.username, getattr(request.state, "client_ip", None))
    except GovernanceDenied as e:
        raise HTTPException(status_code=403, detail=e.message)
    return server, grant, account


def _sftp_error(e: Exception) -> HTTPException:
    msg = getattr(e, "reason", None) or str(e)
    code = 404 if "No such file" in msg else 400
    return HTTPException(status_code=code, detail=f"SFTP: {msg}"[:300])


async def _audit_file(user, server, action, path, ip, result="", status="success"):
    async with async_session() as db:
        db.add(AuditLog(user_id=user.id, server_id=server.id, action=action, status=status, ip_address=ip,
                        command=path, result=result[:500]))
        await db.commit()


@router.get("/servers/{server_id}/files")
async def list_files(server_id: uuid.UUID, request: Request, path: str | None = None,
                     account_id: str | None = None, virtual_account: str | None = None,
                     db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """Browse a directory (needs upload or download)."""
    server, grant = await require_server(db, user, server_id)
    action = PolicyAction.DOWNLOAD.value if PolicyAction.DOWNLOAD.value in grant.actions else PolicyAction.UPLOAD.value
    server, grant, account = await _file_context(db, user, request, server_id, action, account_id, virtual_account)
    try:
        async with sftp.open_sftp(server, account) as client:
            real, entries = await sftp.list_dir(client, sftp.clean_path(path))
    except sftp.SftpError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # noqa: BLE001
        raise _sftp_error(e)
    return {
        "path": real, "account": account.label,
        "can_upload": PolicyAction.UPLOAD.value in grant.actions,
        "can_download": PolicyAction.DOWNLOAD.value in grant.actions,
        "entries": [e.__dict__ for e in entries],
    }


@router.get("/servers/{server_id}/files/download")
async def download_file(server_id: uuid.UUID, request: Request, path: str,
                        account_id: str | None = None, virtual_account: str | None = None,
                        db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    server, _, account = await _file_context(db, user, request, server_id, PolicyAction.DOWNLOAD.value,
                                             account_id, virtual_account)
    path = sftp.clean_path(path)
    max_bytes = await get_setting_int(db, "max_transfer_mb") * 1024 * 1024
    ip = getattr(request.state, "client_ip", None)
    try:
        async with sftp.open_sftp(server, account) as client:
            attrs = await sftp.stat_file(client, path)
    except sftp.SftpError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:  # noqa: BLE001
        raise _sftp_error(e)
    if not stat.S_ISREG(attrs.permissions or 0):
        raise HTTPException(status_code=400, detail="Only regular files can be downloaded")
    if (attrs.size or 0) > max_bytes:
        raise HTTPException(status_code=413, detail=f"File larger than the {max_bytes // (1024 * 1024)} MB limit")

    expected = attrs.size or 0

    async def stream():
        digest, size = hashlib.sha256(), 0
        try:
            async with sftp.open_sftp(server, account) as client:
                async with client.open(path, "rb") as f:
                    while chunk := await f.read(sftp.CHUNK):
                        digest.update(chunk)
                        size += len(chunk)
                        yield chunk
        finally:
            # Starlette cancels the response task once the body is sent: the audit
            # write must survive that cancellation, or downloads go unrecorded.
            with anyio.CancelScope(shield=True):
                await _audit_file(user, server, "file.download", path, ip,
                                  f"account={account.label} size={size} sha256={digest.hexdigest()}",
                                  "success" if size >= expected else "failure")

    name = posixpath.basename(path) or "download"
    return StreamingResponse(stream(), media_type="application/octet-stream", headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{_quote(name)}",
        "Content-Length": str(attrs.size or 0), "Cache-Control": "no-store",
    })


def _quote(name: str) -> str:
    from urllib.parse import quote
    return quote(name, safe="")


@router.post("/servers/{server_id}/files/upload")
async def upload_file(server_id: uuid.UUID, request: Request, directory: str = Form(...),
                      overwrite: bool = Form(False), account_id: str | None = Form(None),
                      virtual_account: str | None = Form(None), file: UploadFile = File(...),
                      db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    server, _, account = await _file_context(db, user, request, server_id, PolicyAction.UPLOAD.value,
                                             account_id, virtual_account)
    name = posixpath.basename(file.filename or "")
    if not name or name in (".", ".."):
        raise HTTPException(status_code=400, detail="Invalid file name")
    dest = posixpath.join(sftp.clean_path(directory) or "/", name)
    max_bytes = await get_setting_int(db, "max_transfer_mb") * 1024 * 1024
    ip = getattr(request.state, "client_ip", None)

    async def chunks():
        while chunk := await file.read(sftp.CHUNK):
            yield chunk

    try:
        async with sftp.open_sftp(server, account) as client:
            size, sha = await sftp.write_stream(client, dest, chunks(), max_bytes, overwrite)
    except sftp.SftpError as e:
        await _audit_file(user, server, "file.upload", dest, ip, f"account={account.label} {e}", "failure")
        raise HTTPException(status_code=409 if isinstance(e, sftp.FileExists) else 400, detail=str(e))
    except Exception as e:  # noqa: BLE001
        await _audit_file(user, server, "file.upload", dest, ip, f"account={account.label} {e}", "failure")
        raise _sftp_error(e)
    await _audit_file(user, server, "file.upload", dest, ip, f"account={account.label} size={size} sha256={sha}")
    return {"path": dest, "size": size, "sha256": sha}


class PathIn(BaseModel):
    path: str
    account_id: str | None = None
    virtual_account: str | None = None


class RenameIn(PathIn):
    new_path: str


async def _write_op(db, user, request, server_id, body: PathIn, op: str, fn):
    server, _, account = await _file_context(db, user, request, server_id, PolicyAction.UPLOAD.value,
                                             body.account_id, body.virtual_account)
    ip = getattr(request.state, "client_ip", None)
    try:
        async with sftp.open_sftp(server, account) as client:
            detail = await fn(client)
    except sftp.SftpError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # noqa: BLE001
        await _audit_file(user, server, op, body.path, ip, f"account={account.label} {e}", "failure")
        raise _sftp_error(e)
    await _audit_file(user, server, op, body.path, ip, f"account={account.label} {detail or ''}")
    return {"ok": True}


@router.post("/servers/{server_id}/files/mkdir")
async def make_dir(server_id: uuid.UUID, body: PathIn, request: Request,
                   db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    path = sftp.clean_path(body.path)
    return await _write_op(db, user, request, server_id, body, "file.mkdir", lambda c: c.mkdir(path))


@router.post("/servers/{server_id}/files/rename")
async def rename_path(server_id: uuid.UUID, body: RenameIn, request: Request,
                      db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    src, dst = sftp.clean_path(body.path), sftp.clean_path(body.new_path)

    async def op(c):
        await c.rename(src, dst)
        return f"-> {dst}"
    return await _write_op(db, user, request, server_id, body, "file.rename", op)


@router.post("/servers/{server_id}/files/delete")
async def delete_path(server_id: uuid.UUID, body: PathIn, request: Request,
                      db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    path = sftp.clean_path(body.path)
    if path in ("", "/"):
        raise HTTPException(status_code=400, detail="Refusing to delete the root directory")
    return await _write_op(db, user, request, server_id, body, "file.delete", lambda c: sftp.remove(c, path))


# ── Zones & gateways (A4) ────────────────────────────────


class GatewayIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(min_length=1, max_length=255)
    credential_id: uuid.UUID | None = None
    use_cert: bool = False
    priority: int = Field(default=10, ge=0, le=1000)
    is_active: bool = True


class ZoneIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None


def _gw_read(g: Gateway) -> dict:
    return {"id": str(g.id), "zone_id": str(g.zone_id), "name": g.name, "host": g.host, "port": g.port,
            "username": g.username, "credential_id": str(g.credential_id) if g.credential_id else None,
            "credential_name": g.credential.name if g.credential else None, "use_cert": g.use_cert,
            "priority": g.priority, "is_active": g.is_active, "last_check_at": g.last_check_at,
            "last_check_ok": g.last_check_ok, "last_check_message": g.last_check_message}


async def _zone_read(db, z: Zone) -> dict:
    from sqlalchemy import func
    from app.models.server import Server
    count = (await db.execute(select(func.count(Server.id)).where(Server.zone_id == z.id))).scalar_one()
    return {"id": str(z.id), "name": z.name, "description": z.description, "server_count": count,
            "gateways": [_gw_read(g) for g in z.gateways], "created_at": z.created_at}


@router.get("/zones")
async def list_zones(db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)):
    zones = (await db.execute(select(Zone).order_by(Zone.name))).scalars().all()
    return [await _zone_read(db, z) for z in zones]


@router.post("/zones", status_code=201)
async def create_zone(data: ZoneIn, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    if (await db.execute(select(Zone.id).where(Zone.name == data.name))).first():
        raise HTTPException(status_code=409, detail="A zone with this name already exists")
    z = Zone(**data.model_dump())
    db.add(z)
    db.add(AuditLog(user_id=user.id, action="zone.create", result=data.name))
    await db.commit()
    z = (await db.execute(select(Zone).where(Zone.id == z.id))).scalar_one()
    return await _zone_read(db, z)


@router.patch("/zones/{zone_id}")
async def update_zone(zone_id: uuid.UUID, data: ZoneIn, db: AsyncSession = Depends(get_db),
                      user: User = Depends(admin_only)):
    z = await db.get(Zone, zone_id)
    if not z:
        raise HTTPException(status_code=404, detail="Zone not found")
    z.name, z.description = data.name, data.description
    db.add(AuditLog(user_id=user.id, action="zone.update", result=data.name))
    await db.commit()
    return await _zone_read(db, z)


@router.delete("/zones/{zone_id}", status_code=204)
async def delete_zone(zone_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    z = await db.get(Zone, zone_id)
    if not z:
        raise HTTPException(status_code=404, detail="Zone not found")
    db.add(AuditLog(user_id=user.id, action="zone.delete", result=z.name))
    await db.delete(z)
    await db.commit()


async def _check_gw_credential(db, data: GatewayIn):
    if not data.use_cert and not data.credential_id:
        raise HTTPException(status_code=400, detail="Choose a credential or the ephemeral certificate")
    if data.credential_id and not await db.get(Credential, data.credential_id):
        raise HTTPException(status_code=400, detail="Credential not found")


@router.post("/zones/{zone_id}/gateways", status_code=201)
async def add_gateway(zone_id: uuid.UUID, data: GatewayIn, db: AsyncSession = Depends(get_db),
                      user: User = Depends(admin_only)):
    if not await db.get(Zone, zone_id):
        raise HTTPException(status_code=404, detail="Zone not found")
    await _check_gw_credential(db, data)
    g = Gateway(zone_id=zone_id, **data.model_dump())
    db.add(g)
    db.add(AuditLog(user_id=user.id, action="gateway.create", result=f"{data.name} {data.host}:{data.port}"))
    await db.commit()
    g = (await db.execute(select(Gateway).where(Gateway.id == g.id))).scalar_one()
    return _gw_read(g)


@router.patch("/gateways/{gateway_id}")
async def update_gateway(gateway_id: uuid.UUID, data: GatewayIn, db: AsyncSession = Depends(get_db),
                         user: User = Depends(admin_only)):
    g = await db.get(Gateway, gateway_id)
    if not g:
        raise HTTPException(status_code=404, detail="Gateway not found")
    await _check_gw_credential(db, data)
    for k, v in data.model_dump().items():
        setattr(g, k, v)
    db.add(AuditLog(user_id=user.id, action="gateway.update", result=data.name))
    await db.commit()
    g = (await db.execute(select(Gateway).where(Gateway.id == gateway_id).execution_options(populate_existing=True))).scalar_one()
    return _gw_read(g)


@router.delete("/gateways/{gateway_id}", status_code=204)
async def delete_gateway(gateway_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    g = await db.get(Gateway, gateway_id)
    if not g:
        raise HTTPException(status_code=404, detail="Gateway not found")
    db.add(AuditLog(user_id=user.id, action="gateway.delete", result=g.name))
    await db.delete(g)
    await db.commit()


@router.post("/gateways/{gateway_id}/check")
async def check_gateway(gateway_id: uuid.UUID, db: AsyncSession = Depends(get_db), _: User = Depends(admin_only)):
    g = (await db.execute(select(Gateway).where(Gateway.id == gateway_id))).scalar_one_or_none()
    if not g:
        raise HTTPException(status_code=404, detail="Gateway not found")
    ok, msg = await routing.check_gateway(g)
    await db.commit()
    return {"ok": ok, "message": msg}


# ── Playbooks (E3) ───────────────────────────────────────


class PlaybookIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    content: str = Field(min_length=1, max_length=200_000)
    variables: dict = Field(default_factory=dict)


def _check_playbook(content: str) -> None:
    try:
        doc = yaml.safe_load(content)
    except yaml.YAMLError as e:
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {e}"[:300])
    if not isinstance(doc, list) or not all(isinstance(p, dict) and "hosts" in p for p in doc):
        raise HTTPException(status_code=400, detail="A playbook is a YAML list of plays, each with 'hosts' (use hosts: all)")


def _pb_read(p: Playbook) -> dict:
    return {"id": str(p.id), "name": p.name, "description": p.description, "content": p.content,
            "variables": p.variables or {}, "created_at": p.created_at}


@router.get("/playbooks")
async def list_playbooks(db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)):
    return [_pb_read(p) for p in (await db.execute(select(Playbook).order_by(Playbook.name))).scalars().all()]


@router.post("/playbooks", status_code=201)
async def create_playbook(data: PlaybookIn, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    _check_playbook(data.content)
    if (await db.execute(select(Playbook.id).where(Playbook.name == data.name))).first():
        raise HTTPException(status_code=409, detail="A playbook with this name already exists")
    p = Playbook(**data.model_dump(), created_by=user.id)
    db.add(p)
    db.add(AuditLog(user_id=user.id, action="playbook.create", result=data.name))
    await db.commit()
    return _pb_read(p)


@router.put("/playbooks/{playbook_id}")
async def update_playbook(playbook_id: uuid.UUID, data: PlaybookIn, db: AsyncSession = Depends(get_db),
                          user: User = Depends(admin_only)):
    p = await db.get(Playbook, playbook_id)
    if not p:
        raise HTTPException(status_code=404, detail="Playbook not found")
    _check_playbook(data.content)
    for k, v in data.model_dump().items():
        setattr(p, k, v)
    db.add(AuditLog(user_id=user.id, action="playbook.update", result=data.name))
    await db.commit()
    return _pb_read(p)


@router.delete("/playbooks/{playbook_id}", status_code=204)
async def delete_playbook(playbook_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    p = await db.get(Playbook, playbook_id)
    if not p:
        raise HTTPException(status_code=404, detail="Playbook not found")
    db.add(AuditLog(user_id=user.id, action="playbook.delete", result=p.name))
    await db.delete(p)
    await db.commit()


# ── Jobs (E2 / E3) ───────────────────────────────────────


class Selector(BaseModel):
    server_ids: list[uuid.UUID] = Field(default_factory=list)
    node_ids: list[uuid.UUID] = Field(default_factory=list)
    labels: list[str] = Field(default_factory=list)
    account: str | None = None  # account username on each server; None = default account


class JobIn(BaseModel):
    kind: str = Field(pattern="^(command|playbook)$")
    name: str | None = Field(default=None, max_length=255)
    command: str | None = Field(default=None, max_length=10000)
    playbook_id: uuid.UUID | None = None
    extra_vars: dict = Field(default_factory=dict)
    selector: Selector
    parallelism: int = Field(default=10, ge=1, le=50)
    timeout: int = Field(default=60, ge=5, le=7200)


def _job_read(j: Job, with_output: bool = False, user_names: dict | None = None) -> dict:
    counts: dict[str, int] = {}
    for t in j.targets:
        counts[t.status] = counts.get(t.status, 0) + 1
    out = {"id": str(j.id), "kind": j.kind, "name": j.name, "command": j.command,
           "playbook_id": str(j.playbook_id) if j.playbook_id else None, "selector": j.selector,
           "parallelism": j.parallelism, "timeout": j.timeout, "status": j.status, "user_id": str(j.user_id),
           "user_name": (user_names or {}).get(str(j.user_id)), "extra_vars": j.extra_vars or {},
           "account": (j.selector or {}).get("account"),
           "created_at": j.created_at, "started_at": j.started_at, "finished_at": j.finished_at,
           "counts": counts, "target_count": len(j.targets)}
    if with_output:
        out["output"] = j.output
        out["targets"] = [{
            "id": str(t.id), "server_id": str(t.server_id) if t.server_id else None, "server_name": t.server_name,
            "account": t.account, "status": t.status, "exit_code": t.exit_code, "stdout": t.stdout,
            "stderr": t.stderr, "message": t.message, "started_at": t.started_at, "finished_at": t.finished_at,
        } for t in j.targets]
    return out


@router.post("/jobs/preview")
async def preview_targets(selector: Selector, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    cands = await jobs_svc.resolve_targets(db, user, selector.model_dump(mode="json"))
    return [{"server_id": str(c.server.id), "server_name": c.server.name, "ip_address": c.server.ip_address,
             "os_type": c.server.os_type.value, "allowed": c.allowed, "reason": c.reason} for c in cands]


@router.post("/jobs", status_code=201)
async def create_job(data: JobIn, request: Request, db: AsyncSession = Depends(get_db),
                     user: User = Depends(require_role(UserRole.ADMIN, UserRole.OPERATOR))):
    playbook = None
    if data.kind == "command":
        data.extra_vars = {}
        if not (data.command or "").strip():
            raise HTTPException(status_code=400, detail="Command is required")
        name = data.name or data.command.strip().splitlines()[0][:120]
    else:
        playbook = await db.get(Playbook, data.playbook_id) if data.playbook_id else None
        if playbook is None:
            raise HTTPException(status_code=400, detail="Playbook not found")
        try:
            jobs_svc.validate_extra_vars(data.extra_vars, playbook, is_admin=user.role == UserRole.ADMIN)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        name = data.name or f"Playbook {playbook.name}"
    try:
        job = await jobs_svc.create_job(
            db, user, kind=data.kind, name=name, selector=data.selector.model_dump(mode="json"),
            command=data.command, playbook=playbook, extra_vars=data.extra_vars,
            parallelism=data.parallelism, timeout=data.timeout if data.kind == "command" else max(data.timeout, 60),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    job = (await db.execute(select(Job).where(Job.id == job.id))).scalar_one()  # loads targets
    db.add(AuditLog(user_id=user.id, action=f"job.{data.kind}", ip_address=getattr(request.state, "client_ip", None),
                    command=data.command or (playbook.name if playbook else None),
                    result=f"{job.id} {len(job.targets)} target(s)"))
    await db.commit()
    return _job_read(job, with_output=True)


@router.get("/jobs")
async def list_jobs(limit: int = Query(default=50, ge=1, le=200), db: AsyncSession = Depends(get_db),
                    user: User = Depends(get_current_user)):
    q = select(Job).order_by(Job.created_at.desc()).limit(limit)
    if user.role != UserRole.ADMIN:
        q = q.where(Job.user_id == user.id)
    names = {str(i): n for i, n in (await db.execute(select(User.id, User.display_name))).all()}
    return [_job_read(j, user_names=names) for j in (await db.execute(q)).scalars().all()]


async def _get_job(db, user, job_id) -> Job:
    j = (await db.execute(select(Job).where(Job.id == job_id).execution_options(populate_existing=True))).scalar_one_or_none()
    if not j or (user.role != UserRole.ADMIN and j.user_id != user.id):
        raise HTTPException(status_code=404, detail="Job not found")
    return j


@router.get("/jobs/{job_id}")
async def get_job(job_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    job = await _get_job(db, user, job_id)
    owner = await db.get(User, job.user_id)
    return _job_read(job, with_output=True, user_names={str(job.user_id): owner.display_name if owner else None})


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    job = await _get_job(db, user, job_id)
    if not await jobs_svc.cancel_job(db, job):
        raise HTTPException(status_code=409, detail="Job is not running")
    db.add(AuditLog(user_id=user.id, action="job.cancel", result=str(job.id)))
    await db.commit()
    return _job_read(job, with_output=True)


# ── Cloud accounts (A8) ──────────────────────────────────


class CloudIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    provider: str = Field(default="azure", pattern="^azure$")
    config: dict = Field(default_factory=dict)  # tenant_id, client_id, subscription_ids[], use_public_ip, only_running
    secret: str | None = None                   # client secret; omitted on update = unchanged
    node_id: uuid.UUID | None = None
    zone_id: uuid.UUID | None = None
    is_active: bool = True
    sync_interval_minutes: int = Field(default=60, ge=5, le=10080)


def _cloud_read(a: CloudAccount) -> dict:
    return {"id": str(a.id), "name": a.name, "provider": a.provider, "config": a.config or {},
            "has_secret": bool(a.encrypted_secret), "node_id": str(a.node_id) if a.node_id else None,
            "zone_id": str(a.zone_id) if a.zone_id else None, "is_active": a.is_active,
            "sync_interval_minutes": a.sync_interval_minutes, "last_sync_at": a.last_sync_at,
            "last_sync_status": a.last_sync_status, "last_sync_message": a.last_sync_message,
            "created_at": a.created_at}


def _check_cloud(cfg: dict) -> None:
    for k in ("tenant_id", "client_id"):
        if not cfg.get(k):
            raise HTTPException(status_code=400, detail=f"Azure config needs {k}")
    if not cfg.get("subscription_ids"):
        raise HTTPException(status_code=400, detail="Azure config needs at least one subscription id")


@router.get("/cloud-accounts")
async def list_cloud(db: AsyncSession = Depends(get_db), _: User = Depends(admin_only)):
    return [_cloud_read(a) for a in (await db.execute(select(CloudAccount).order_by(CloudAccount.name))).scalars().all()]


@router.post("/cloud-accounts", status_code=201)
async def create_cloud(data: CloudIn, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    _check_cloud(data.config)
    if not data.secret:
        raise HTTPException(status_code=400, detail="Client secret is required")
    if (await db.execute(select(CloudAccount.id).where(CloudAccount.name == data.name))).first():
        raise HTTPException(status_code=409, detail="A cloud account with this name already exists")
    a = CloudAccount(**data.model_dump(exclude={"secret"}), encrypted_secret=encrypt_value(data.secret))
    db.add(a)
    db.add(AuditLog(user_id=user.id, action="cloud.create", result=data.name))
    await db.commit()
    return _cloud_read(a)


@router.patch("/cloud-accounts/{account_id}")
async def update_cloud(account_id: uuid.UUID, data: CloudIn, db: AsyncSession = Depends(get_db),
                       user: User = Depends(admin_only)):
    a = await db.get(CloudAccount, account_id)
    if not a:
        raise HTTPException(status_code=404, detail="Cloud account not found")
    _check_cloud(data.config)
    for k, v in data.model_dump(exclude={"secret"}).items():
        setattr(a, k, v)
    if data.secret:
        a.encrypted_secret = encrypt_value(data.secret)
    db.add(AuditLog(user_id=user.id, action="cloud.update", result=data.name))
    await db.commit()
    return _cloud_read(a)


@router.delete("/cloud-accounts/{account_id}", status_code=204)
async def delete_cloud(account_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    a = await db.get(CloudAccount, account_id)
    if not a:
        raise HTTPException(status_code=404, detail="Cloud account not found")
    db.add(AuditLog(user_id=user.id, action="cloud.delete", result=f"{a.name} (imported servers kept)"))
    await db.delete(a)
    await db.commit()


@router.post("/cloud-accounts/{account_id}/sync")
async def sync_cloud(account_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    a = await db.get(CloudAccount, account_id)
    if not a:
        raise HTTPException(status_code=404, detail="Cloud account not found")
    stats = await cloud_sync.sync_account(db, a, actor_id=user.id)
    a = await db.get(CloudAccount, account_id)
    return {"stats": stats, "account": _cloud_read(a)}
