"""Multi-server jobs (E2) and Ansible playbooks (E3).

Command jobs: each target is checked like an interactive command (rights,
connection ACL, command ACL); ALERT runs and notifies, DENY / REVIEW skip the
target with the reason (no bulk approval). Every run lands in the command
journal (source "job").

Playbook jobs: an inventory is generated in a private temp dir (0700) with
each target's account (password, key or ephemeral certificate). Servers in
a zone are reached through a local port forward over their gateway. The
temp dir (secrets) is deleted when the run ends. Command ACLs do not apply
to playbooks: creating / editing playbooks is admin-only, running one needs
the "execute" right on every target.
"""

import asyncio
import json
import logging
import os
import re
import shutil
import tempfile
import uuid
from contextlib import AsyncExitStack
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.members import load_member
from app.core.database import async_session
from app.core.permissions import (
    ServerGrant, account_to_resolved, compute_grants, node_descendants, ADMIN_GRANT, ResolvedAccount,
)
from app.core.security import decrypt_value
from app.models.base import OSType, UserRole
from app.models.operations import Job, JobTarget, Playbook
from app.models.pam import Node, PolicyAction
from app.models.server import Server
from app.models.user import User
from app.services import connection_manager, routing
from app.services.command_log import log_command
from app.services.enforcement import GovernanceDenied, check_command, enforce_connect

logger = logging.getLogger("citadel.jobs")
MAX_OUTPUT = 200_000  # chars kept per target / per playbook log
_running: dict[str, asyncio.Task] = {}


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Targets ──────────────────────────────────────────────


@dataclass
class Candidate:
    server: Server
    allowed: bool
    reason: str | None
    grant: ServerGrant | None


async def resolve_targets(db: AsyncSession, user: User, selector: dict) -> list[Candidate]:
    """Servers matched by the selector, with whether the user may run on each."""
    server_ids = {str(s) for s in selector.get("server_ids") or []}
    node_ids = {uuid.UUID(str(n)) for n in selector.get("node_ids") or []}
    labels = selector.get("labels") or []
    if node_ids:
        pairs = [(r[0], r[1]) for r in (await db.execute(select(Node.id, Node.parent_id))).all()]
        node_ids = node_descendants(pairs, node_ids)
    servers = (await db.execute(select(Server).order_by(Server.name))).scalars().all()

    def matches(s: Server) -> bool:
        if str(s.id) in server_ids or (s.node_id and s.node_id in node_ids):
            return True
        for sel in labels:
            k, _, v = sel.partition("=")
            if s.tags and k in s.tags and (v == "" or str(s.tags[k]) == v):
                return True
        return False

    grants = await compute_grants(db, user)
    out = []
    for s in servers:
        if not matches(s):
            continue
        grant = ADMIN_GRANT if grants is None else grants.get(s.id)
        if grant is None:
            continue  # invisible servers are not even listed
        if PolicyAction.EXECUTE.value not in grant.actions:
            out.append(Candidate(s, False, "Droit « exécuter » non accordé", grant))
            continue
        try:
            pick_account(s, grant, selector.get("account"))
        except ValueError as e:
            out.append(Candidate(s, False, str(e), grant))
            continue
        out.append(Candidate(s, True, None, grant))
    return out


def pick_account(server: Server, grant: ServerGrant, username: str | None) -> ResolvedAccount:
    accounts = [a for a in server.accounts if a.is_active]
    if username:
        acc = next((a for a in accounts if a.username == username), None)
        if acc is None:
            raise ValueError(f"Pas de compte « {username} » sur ce serveur")
    else:
        acc = next((a for a in accounts if a.is_default), None)
        if acc is None:
            raise ValueError("Pas de compte par défaut")
    if not grant.allows_account(acc.username):
        raise ValueError(f"Compte « {acc.username} » non accordé")
    return account_to_resolved(acc)


# ── Lifecycle ────────────────────────────────────────────


async def create_job(db: AsyncSession, user: User, *, kind: str, name: str, selector: dict,
                     command: str | None = None, playbook: Playbook | None = None, extra_vars: dict | None = None,
                     parallelism: int = 10, timeout: int = 60, client_ip: str | None = None) -> Job:
    candidates = await resolve_targets(db, user, selector)
    if not candidates:
        raise ValueError("Aucun serveur ne correspond à la sélection")
    job = Job(kind=kind, name=name, command=command, playbook_id=playbook.id if playbook else None,
              extra_vars=extra_vars or {}, selector=selector, parallelism=parallelism, timeout=timeout,
              user_id=user.id, client_ip=client_ip, status="pending")
    db.add(job)
    await db.flush()
    for c in candidates:
        db.add(JobTarget(job_id=job.id, server_id=c.server.id, server_name=c.server.name,
                         status="pending" if c.allowed else "skipped", message=c.reason))
    await db.commit()
    task = asyncio.create_task(_run_job(job.id))
    _running[str(job.id)] = task
    task.add_done_callback(lambda _t, jid=str(job.id): _running.pop(jid, None))
    return job


async def cancel_job(db: AsyncSession, job: Job) -> bool:
    if job.status not in ("pending", "running"):
        return False
    task = _running.get(str(job.id))
    if task:
        task.cancel()
    job.status = "cancelled"
    job.finished_at = _now()
    for t in job.targets:
        if t.status in ("pending", "running"):
            t.status = "cancelled"
    await db.commit()
    return True


async def mark_interrupted() -> int:
    """At startup: jobs left running by a previous process cannot be resumed."""
    from app.core import tenancy
    with tenancy.system():   # every organisation's jobs
        return await _mark_interrupted()


async def _mark_interrupted() -> int:
    async with async_session() as db:
        jobs = (await db.execute(select(Job).where(Job.status.in_(["pending", "running"])))).scalars().all()
        for j in jobs:
            j.status = "failed"
            j.finished_at = _now()
            j.output = (j.output or "") + "\n[Citadel] Tâche interrompue par un redémarrage du service."
            for t in j.targets:
                if t.status in ("pending", "running"):
                    t.status, t.message = "failed", "Interrompue par un redémarrage"
        await db.commit()
        return len(jobs)


async def _run_job(job_id) -> None:
    async with async_session() as db:
        job = await db.get(Job, job_id)
        job.status, job.started_at = "running", _now()
        await db.commit()
    try:
        if job.kind == "command":
            await _run_command_job(job_id)
        elif job.kind == "push":
            from app.services.account_push import run_push_job
            await run_push_job(job_id)
        else:
            await _run_playbook_job(job_id)
    except asyncio.CancelledError:
        return
    except Exception as e:  # noqa: BLE001
        logger.exception("job %s failed", job_id)
        async with async_session() as db:
            job = await db.get(Job, job_id)
            job.output = (job.output or "") + f"\n[Citadel] Erreur : {type(e).__name__}: {e}"
            await db.commit()
    async with async_session() as db:
        job = (await db.execute(select(Job).where(Job.id == job_id).execution_options(populate_existing=True))).scalar_one()
        if job.status == "cancelled":
            return
        states = [t.status for t in job.targets if t.status != "skipped"]
        if not states:
            job.status = "failed"
        elif all(s == "success" for s in states):
            job.status = "success"
        elif any(s == "success" for s in states):
            job.status = "partial"
        else:
            job.status = "failed"
        job.finished_at = _now()
        await db.commit()


# ── Command jobs ─────────────────────────────────────────


async def _run_command_job(job_id) -> None:
    async with async_session() as db:
        job = await db.get(Job, job_id)
        target_ids = [t.id for t in job.targets if t.status == "pending"]
        sem = asyncio.Semaphore(max(1, min(job.parallelism, 50)))
        command, timeout, user_id, account_name = job.command, job.timeout, job.user_id, (job.selector or {}).get("account")
        ip = job.client_ip

    async def one(target_id):
        async with sem:
            async with async_session() as db:
                t = await db.get(JobTarget, target_id)
                job = await db.get(Job, job_id)
                if job.status == "cancelled":
                    return
                user = await load_member(db, user_id)
                server = (await db.execute(select(Server).where(Server.id == t.server_id))).scalar_one_or_none()
                t.status, t.started_at = "running", _now()
                await db.commit()
                try:
                    if server is None:
                        raise ValueError("Serveur supprimé")
                    if user is None:
                        raise ValueError("Le demandeur n'est plus membre actif de l'organisation")
                    grants = await compute_grants(db, user)
                    grant = ADMIN_GRANT if grants is None else grants.get(server.id)
                    if grant is None or PolicyAction.EXECUTE.value not in grant.actions:
                        raise ValueError("Droit « exécuter » retiré entre-temps")
                    account = pick_account(server, grant, account_name)
                    t.account = account.label
                    await enforce_connect(db, user, server, account.username, ip)
                    outcome = await check_command(db, user, server, account.username, command, ip, source="job")
                    if not outcome.allowed:
                        await log_command(db, user=user, server=server, account=account.label, command=command,
                                          source="job", decision=outcome.decision, rule=outcome.rule, ip=ip)
                        t.status, t.message = "skipped", outcome.message
                    else:
                        res = await connection_manager.execute_command(server, account, command, timeout=timeout)
                        t.exit_code = res.exit_code
                        t.stdout, t.stderr = res.stdout[:MAX_OUTPUT], res.stderr[:MAX_OUTPUT]
                        t.status = "success" if res.exit_code == 0 else "failed"
                        await log_command(db, user=user, server=server, account=account.label, command=command,
                                          source="job", decision=outcome.decision, rule=outcome.rule,
                                          exit_code=res.exit_code, ip=ip)
                except GovernanceDenied as e:
                    t.status, t.message = "skipped", e.message
                except asyncio.TimeoutError:
                    t.status, t.message = "failed", f"Délai dépassé ({timeout} s)"
                except Exception as e:  # noqa: BLE001
                    t.status, t.message = "failed", f"{type(e).__name__}: {e}"[:500]
                t.finished_at = _now()
                await db.commit()

    await asyncio.gather(*(one(tid) for tid in target_ids))


# ── Extra vars hardening ─────────────────────────────────

# Ansible gives extra vars the highest precedence (above inventory host vars),
# so a free-form value could replace the connection (ansible_connection=local,
# ansible_host=<attacker>, ansible_ssh_common_args=ProxyCommand...) or run a
# Jinja lookup on the controller. Extra vars are therefore restricted.
EXTRA_VAR_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
RESERVED_VARS = {
    "hostvars", "groups", "group_names", "inventory_hostname", "inventory_hostname_short",
    "inventory_dir", "inventory_file", "playbook_dir", "play_hosts", "role_path", "role_name",
    "omit", "environment", "vars", "lookup", "query", "q", "item", "connection", "become",
    "become_user", "become_method", "remote_user", "delegate_to",
}
TEMPLATE_MARKERS = ("{{", "{%", "{#")


def _check_value(value, path: str, depth: int = 0) -> None:
    if depth > 5:
        raise ValueError(f"Variable « {path} » : structure trop profonde")
    if value is None or isinstance(value, (bool, int, float)):
        return
    if isinstance(value, str):
        if len(value) > 4096:
            raise ValueError(f"Variable « {path} » : valeur trop longue")
        if any(m in value for m in TEMPLATE_MARKERS):
            raise ValueError(f"Variable « {path} » : la syntaxe de modèle ({{{{ }}}}, {{% %}}) est interdite")
        return
    if isinstance(value, list):
        for i, v in enumerate(value):
            _check_value(v, f"{path}[{i}]", depth + 1)
        return
    if isinstance(value, dict):
        for k, v in value.items():
            if not isinstance(k, str) or any(m in k for m in TEMPLATE_MARKERS):
                raise ValueError(f"Variable « {path} » : clé invalide")
            _check_value(v, f"{path}.{k}", depth + 1)
        return
    raise ValueError(f"Variable « {path} » : type non pris en charge")


def validate_extra_vars(extra_vars: dict, playbook: Playbook, is_admin: bool) -> dict:
    """Run-time variables: declared keys only for non-admins, never Ansible's own
    variables, never templating. Raises ValueError with a user-facing message."""
    if not isinstance(extra_vars, dict):
        raise ValueError("Les variables doivent être un objet JSON")
    declared = set((playbook.variables or {}).keys())
    for key, value in extra_vars.items():
        if not isinstance(key, str) or not EXTRA_VAR_KEY.match(key):
            raise ValueError(f"Nom de variable invalide : « {key} »")
        if key.lower().startswith("ansible_") or key in RESERVED_VARS:
            raise ValueError(f"La variable « {key} » est réservée à Ansible et ne peut pas être passée au lancement")
        if not is_admin and key not in declared:
            raise ValueError(f"La variable « {key} » n'est pas déclarée dans ce playbook "
                             "(seules les variables par défaut du playbook peuvent être remplacées)")
        _check_value(value, key)
    return extra_vars


class _Unsafe(str):
    """Rendered as `!unsafe 'value'`: Ansible never templates it."""


def _unsafe_tree(value):
    if isinstance(value, str):
        return _Unsafe(value)
    if isinstance(value, list):
        return [_unsafe_tree(v) for v in value]
    if isinstance(value, dict):
        return {k: _unsafe_tree(v) for k, v in value.items()}
    return value


def render_vars_file(defaults: dict, extra: dict) -> str:
    """YAML vars file: admin-authored defaults as-is, run-time values tagged !unsafe."""
    import yaml

    class _Dumper(yaml.SafeDumper):
        pass

    _Dumper.add_representer(_Unsafe, lambda d, v: d.represent_scalar("!unsafe", str(v), style="'"))
    merged = {**(defaults or {}), **_unsafe_tree(extra or {})}
    return yaml.dump(merged, Dumper=_Dumper, allow_unicode=True, sort_keys=False)


# ── Playbook jobs ────────────────────────────────────────

_HOST_RE = re.compile(r"[^A-Za-z0-9_.-]+")
RECAP_RE = re.compile(r"^(\S+)\s+:\s+ok=(\d+)\s+changed=(\d+)\s+unreachable=(\d+)\s+failed=(\d+)", re.M)


def _inventory_host(server: Server, account: ResolvedAccount, workdir: str, host: str, port: int) -> dict:
    h: dict = {"ansible_host": host, "ansible_port": port, "ansible_user": account.username}
    if server.os_type == OSType.WINDOWS:
        h.update({"ansible_connection": "winrm", "ansible_winrm_transport": "ntlm",
                  "ansible_winrm_scheme": "http", "ansible_winrm_server_cert_validation": "ignore",
                  "ansible_password": decrypt_value(account.password) if account.password else None})
        return h
    h["ansible_connection"] = "ssh"
    if account.use_cert:
        from app.services.ca_service import sign_user_certificate
        key_path, _cert = sign_user_certificate(username=account.username, validity_minutes=120)
        dest = os.path.join(workdir, f"key-{uuid.uuid4().hex}")
        shutil.copy(key_path, dest)
        shutil.copy(key_path + "-cert.pub", dest + "-cert.pub")
        from app.services.ca_service import cleanup_cert_files
        cleanup_cert_files(key_path)
        os.chmod(dest, 0o600)
        h["ansible_ssh_private_key_file"] = dest
    elif account.ssh_key:
        dest = os.path.join(workdir, f"key-{uuid.uuid4().hex}")
        with open(dest, "w") as f:
            f.write(decrypt_value(account.ssh_key))
        os.chmod(dest, 0o600)
        h["ansible_ssh_private_key_file"] = dest
    elif account.password:
        h["ansible_password"] = decrypt_value(account.password)
    return h


async def _run_playbook_job(job_id) -> None:
    workdir = tempfile.mkdtemp(prefix="citadel-ansible-")
    os.chmod(workdir, 0o700)
    stack = AsyncExitStack()
    try:
        async with async_session() as db:
            job = await db.get(Job, job_id)
            playbook = await db.get(Playbook, job.playbook_id) if job.playbook_id else None
            if playbook is None:
                raise ValueError("Playbook supprimé")
            user = await load_member(db, job.user_id)
            if user is None:
                raise ValueError("Le demandeur n'est plus membre de l'organisation")
            account_name = (job.selector or {}).get("account")
            ip = job.client_ip
            grants = await compute_grants(db, user)
            hosts, host_to_target = {}, {}
            for t in job.targets:
                if t.status != "pending":
                    continue
                server = (await db.execute(select(Server).where(Server.id == t.server_id))).scalar_one_or_none()
                try:
                    if server is None:
                        raise ValueError("Serveur supprimé")
                    grant = ADMIN_GRANT if grants is None else grants.get(server.id)
                    if grant is None or PolicyAction.EXECUTE.value not in grant.actions:
                        raise ValueError("Droit « exécuter » retiré entre-temps")
                    account = pick_account(server, grant, account_name)
                    await enforce_connect(db, user, server, account.username, ip)
                    port = server.ssh_port if server.os_type == OSType.LINUX else server.winrm_port
                    await stack.enter_async_context(routing.via(server))
                    host, port = await routing.tcp_endpoint(server.ip_address, port)
                    name = _HOST_RE.sub("_", server.name) or f"srv_{server.id.hex[:8]}"
                    while name in hosts:
                        name += "_"
                    hosts[name] = _inventory_host(server, account, workdir, host, port)
                    host_to_target[name] = t.id
                    t.account, t.status, t.started_at = account.label, "running", _now()
                    await log_command(db, user=user, server=server, account=account.label,
                                      command=f"ansible-playbook {playbook.name}", source="playbook",
                                      decision="allowed", ip=ip)
                except GovernanceDenied as e:
                    t.status, t.message = "skipped", e.message
                except Exception as e:  # noqa: BLE001
                    t.status, t.message = "failed", f"{type(e).__name__}: {e}"[:500]
            await db.commit()
            if not hosts:
                return
            pb_path = os.path.join(workdir, "playbook.yml")
            with open(pb_path, "w") as f:
                f.write(playbook.content)
            inv_path = os.path.join(workdir, "inventory.json")
            with open(inv_path, "w") as f:
                json.dump({"all": {"hosts": hosts}}, f)
            os.chmod(inv_path, 0o600)
            vars_path = os.path.join(workdir, "vars.yml")
            # Re-checked here too (defence in depth: the API already validated them)
            validate_extra_vars(job.extra_vars or {}, playbook, is_admin=user.role == UserRole.ADMIN)
            with open(vars_path, "w") as f:
                f.write(render_vars_file(playbook.variables or {}, job.extra_vars or {}))
            forks, timeout = max(1, min(job.parallelism, 50)), job.timeout

        # Minimal environment: never hand the backend's own variables (DB URL, vault
        # settings, encryption key...) to the Ansible process.
        env = {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "LANG": "C.UTF-8",
               "ANSIBLE_HOST_KEY_CHECKING": "False", "ANSIBLE_NOCOLOR": "1",
               "ANSIBLE_FORCE_COLOR": "0", "ANSIBLE_RETRY_FILES_ENABLED": "False",
               "ANSIBLE_LOCAL_TEMP": os.path.join(workdir, "tmp"), "ANSIBLE_SSH_ARGS": "-o ControlMaster=no",
               "HOME": workdir}
        proc = await asyncio.create_subprocess_exec(
            "ansible-playbook", "-i", inv_path, pb_path, "-e", f"@{vars_path}", "--forks", str(forks),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=env, cwd=workdir,
        )
        log = []

        async def pump():
            last_flush = 0.0
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                log.append(line.decode("utf-8", errors="replace"))
                now = asyncio.get_running_loop().time()
                if now - last_flush > 2:  # live log for the UI
                    last_flush = now
                    async with async_session() as db2:
                        j = await db2.get(Job, job_id)
                        j.output = "".join(log)[-MAX_OUTPUT:]
                        await db2.commit()

        try:
            await asyncio.wait_for(asyncio.gather(pump(), proc.wait()), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            log.append(f"\n[Citadel] Délai dépassé ({timeout} s), playbook interrompu.\n")
        except asyncio.CancelledError:
            proc.kill()
            raise
        output = "".join(log)
        recap = {m.group(1): (int(m.group(4)), int(m.group(5))) for m in RECAP_RE.finditer(output)}
        async with async_session() as db:
            job = await db.get(Job, job_id)
            job.output = output[-MAX_OUTPUT:]
            for name, tid in host_to_target.items():
                t = await db.get(JobTarget, tid)
                if name in recap:
                    unreachable, failed = recap[name]
                    t.status = "success" if not unreachable and not failed else "failed"
                    t.message = None if t.status == "success" else ("Injoignable" if unreachable else "Tâche(s) en échec")
                    t.exit_code = 0 if t.status == "success" else 2
                else:
                    t.status, t.message = "failed", "Absent du récapitulatif Ansible"
                t.finished_at = _now()
            await db.commit()
    finally:
        await stack.aclose()
        shutil.rmtree(workdir, ignore_errors=True)  # inventory holds secrets
