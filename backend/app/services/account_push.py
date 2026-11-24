"""Push an account template to many servers (lot 7).

For each target, with the server's default (privileged) account: create the
OS user if missing, set its secret (generated, never shown), add groups and
sudo rights, check that the new secret works, then register the account in
Citadel with a dedicated credential (encrypted in the vault). Runs as a job
(kind "push"), so targets, progress and results show in Tâches.
"""

import asyncio
import re
from dataclasses import dataclass

import asyncssh
from sqlalchemy import select

from app.core.database import async_session
from app.core.permissions import ResolvedAccount
from app.core.security import encrypt_value
from app.models.audit import AuditLog
from app.models.base import CredentialType, OSType
from app.models.credential import Credential
from app.models.operations import Job, JobTarget
from app.models.pam import Account, AccountTemplate
from app.models.server import Server
from app.services import secrets_ops

LINUX_USER = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
WINDOWS_USER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$")
GROUP_NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9 ._-]{0,63}$")
RESERVED = {"root", "administrator", "admin", "guest", "daemon", "bin", "sys", "nobody", "sshd"}


def validate_template(username: str, os_scope: str, secret_type: str, sudo: str, groups: list[str]) -> None:
    if username.lower() in RESERVED:
        raise ValueError(f"« {username} » est un compte système : choisissez un autre nom")
    if os_scope in ("any", "linux") and not LINUX_USER.match(username):
        raise ValueError("Nom invalide pour Linux (minuscules, chiffres, _ et -, 32 caractères au plus)")
    if os_scope in ("any", "windows") and not WINDOWS_USER.match(username):
        raise ValueError("Nom invalide pour Windows (20 caractères au plus)")
    if os_scope == "windows" and secret_type != "password":
        raise ValueError("Sous Windows, seul un mot de passe est possible")
    if os_scope == "windows" and sudo != "none":
        raise ValueError("sudo ne s'applique pas à Windows (utiliser les groupes)")
    for g in groups:
        if not GROUP_NAME.match(g):
            raise ValueError(f"Nom de groupe invalide : {g}")


@dataclass
class _Secret:
    password: str | None = None
    private_key: str | None = None
    public_key: str | None = None


def _generate(tpl: AccountTemplate) -> _Secret:
    if tpl.secret_type == "password":
        return _Secret(password=secrets_ops.generate_password(max(16, tpl.password_length)))
    if tpl.secret_type == "ssh_key":
        k = asyncssh.generate_private_key("ssh-ed25519", comment=f"citadel-{tpl.username}")
        return _Secret(private_key=k.export_private_key().decode(), public_key=k.export_public_key().decode().strip())
    return _Secret()  # cert: no secret, Citadel signs short-lived certificates


def linux_script(tpl: AccountTemplate, secret: _Secret) -> str:
    """Shell script run as root (sh -s). Inputs are validated: no quoting issue."""
    u = tpl.username
    lines = [
        "set -e",
        f"id -u {u} >/dev/null 2>&1 || useradd -m -s /bin/bash {u}",
    ]
    for g in tpl.groups or []:
        if " " in g:
            raise ValueError(f"Groupe Linux avec espace : {g}")
        lines.append(f"getent group {g} >/dev/null || groupadd {g}")
        lines.append(f"usermod -aG {g} {u}")
    if secret.public_key:
        lines += [
            f"H=$(getent passwd {u} | cut -d: -f6)",
            f"install -d -m 700 -o {u} -g $(id -gn {u}) \"$H/.ssh\"",
            f"touch \"$H/.ssh/authorized_keys\"",
            f"grep -qxF '{secret.public_key}' \"$H/.ssh/authorized_keys\" || echo '{secret.public_key}' >> \"$H/.ssh/authorized_keys\"",
            f"chown {u}:$(id -gn {u}) \"$H/.ssh/authorized_keys\" && chmod 600 \"$H/.ssh/authorized_keys\"",
        ]
    if tpl.secret_type in ("ssh_key", "cert"):
        # "*" = no password but NOT locked: a locked account ("!", useradd's default)
        # is refused by sshd even for keys / certificates when PAM is off (Alpine...)
        lines.append(f"usermod -p '*' {u}")
    sudo_file = f"/etc/sudoers.d/citadel-{u}"
    if tpl.sudo in ("password", "nopasswd"):
        rule = f"{u} ALL=(ALL) " + ("NOPASSWD: ALL" if tpl.sudo == "nopasswd" else "ALL")
        lines += [
            f"echo '{rule}' > {sudo_file}.tmp && chmod 440 {sudo_file}.tmp",
            f"visudo -cf {sudo_file}.tmp >/dev/null && mv {sudo_file}.tmp {sudo_file} || {{ rm -f {sudo_file}.tmp; exit 3; }}",
        ]
    else:
        lines.append(f"rm -f {sudo_file}")
    lines.append("echo citadel-push-ok")
    return "\n".join(lines) + "\n"


def windows_script(tpl: AccountTemplate, secret: _Secret) -> str:
    u = tpl.username
    groups = ", ".join(f"'{g}'" for g in (tpl.groups or []))
    return (
        f"$p = ConvertTo-SecureString '{secret.password}' -AsPlainText -Force; "
        f"if (Get-LocalUser -Name '{u}' -ErrorAction SilentlyContinue) "
        f"{{ Set-LocalUser -Name '{u}' -Password $p -PasswordNeverExpires $true -ErrorAction Stop }} "
        f"else {{ New-LocalUser -Name '{u}' -Password $p -PasswordNeverExpires -AccountNeverExpires -ErrorAction Stop | Out-Null }}; "
        + (f"foreach ($g in @({groups})) {{ if (-not (Get-LocalGroupMember -Group $g -Member '{u}' -ErrorAction SilentlyContinue)) "
           f"{{ Add-LocalGroupMember -Group $g -Member '{u}' -ErrorAction Stop }} }}; " if groups else "")
        + "Write-Output 'citadel-push-ok'"
    )


def _sudo(executor: ResolvedAccount, cmd: str) -> str:
    return cmd if executor.username == "root" else f"sudo -n {cmd}"


async def push_one(db, tpl: AccountTemplate, server: Server, update_existing: bool) -> tuple[str, str]:
    """Returns (status, message): success | skipped | failed."""
    if tpl.os_scope != "any" and server.os_type.value != tpl.os_scope:
        return "skipped", f"Modèle réservé à {tpl.os_scope}"
    if server.os_type == OSType.WINDOWS and tpl.secret_type != "password":
        return "skipped", "Windows : seul un mot de passe est possible"
    if server.os_type == OSType.WINDOWS and not WINDOWS_USER.match(tpl.username):
        return "skipped", "Nom invalide pour Windows"
    existing = next((a for a in server.accounts if a.username == tpl.username), None)
    if existing is not None and not update_existing:
        return "skipped", "Compte déjà géré par Citadel (cocher « mettre à jour » pour le repousser)"
    try:
        executor = secrets_ops._executor(server)
    except ValueError as e:
        return "skipped", str(e)

    secret = _generate(tpl)
    if server.os_type == OSType.LINUX:
        res = await secrets_ops._run(server, executor, _sudo(executor, "sh -s"), stdin=linux_script(tpl, secret), timeout=90)
        if res.exit_code != 0 or "citadel-push-ok" not in (res.stdout or ""):
            return "failed", secrets_ops._short(res.stderr or res.stdout or f"code {res.exit_code}")
        if secret.password:
            r2 = await secrets_ops._change_password_on_target(server, executor, tpl.username, secret.password)
            if not r2.ok:
                return "failed", f"Mot de passe : {r2.message}"
    else:
        res = await secrets_ops._run(server, executor, windows_script(tpl, secret), timeout=90)
        if res.exit_code != 0 or "citadel-push-ok" not in (res.stdout or ""):
            return "failed", secrets_ops._short(res.stderr or res.stdout or f"code {res.exit_code}")

    # Check the new secret before Citadel relies on it
    if tpl.secret_type != "cert":
        probe = ResolvedAccount(
            username=tpl.username,
            password=encrypt_value(secret.password) if secret.password else None,
            ssh_key=encrypt_value(secret.private_key) if secret.private_key else None,
        )
        ok, msg = await secrets_ops._test_login(server, probe)
        if not ok:
            return "failed", f"Compte créé mais la connexion échoue : {secrets_ops._short(msg, 300)}"

    cred = None
    if tpl.secret_type != "cert":
        ctype = (CredentialType.WINRM if server.os_type == OSType.WINDOWS
                 else CredentialType.SSH_KEY if secret.private_key else CredentialType.SSH_PASSWORD)
        cred = Credential(
            name=f"{server.name}/{tpl.username}", type=ctype, username=tpl.username,
            encrypted_password=encrypt_value(secret.password) if secret.password else None,
            encrypted_ssh_key=encrypt_value(secret.private_key) if secret.private_key else None,
        )
        db.add(cred)
        await db.flush()
    acc = existing or Account(server_id=server.id, username=tpl.username)
    if existing is None:
        db.add(acc)
    acc.credential_id = cred.id if cred else None
    acc.use_cert = tpl.secret_type == "cert"
    acc.privileged = tpl.privileged
    acc.is_active = True
    acc.description = f"Poussé depuis le modèle « {tpl.name} »"
    acc.rotation_enabled = tpl.rotation_enabled and tpl.secret_type == "password"
    acc.rotation_interval_days = tpl.rotation_interval_days
    acc.verify_status, acc.verify_message = ("ok", "vérifié au push") if tpl.secret_type != "cert" else ("unknown", None)
    return "success", ("mis à jour" if existing else "créé") + f" ({tpl.secret_type})"


async def run_push_job(job_id) -> None:
    from app.services.jobs import _now
    async with async_session() as db:
        job = await db.get(Job, job_id)
        tpl_id = (job.extra_vars or {}).get("template_id")
        update_existing = bool((job.extra_vars or {}).get("update_existing"))
        user_id = job.user_id
        target_ids = [t.id for t in job.targets if t.status == "pending"]
        sem = asyncio.Semaphore(max(1, min(job.parallelism, 20)))

    async def one(tid):
        async with sem:
            async with async_session() as db:
                t = await db.get(JobTarget, tid)
                job = await db.get(Job, job_id)
                if job.status == "cancelled":
                    return
                tpl = await db.get(AccountTemplate, tpl_id)
                server = (await db.execute(select(Server).where(Server.id == t.server_id))).scalar_one_or_none()
                t.status, t.started_at = "running", _now()
                await db.commit()
                try:
                    if tpl is None:
                        raise ValueError("Modèle supprimé")
                    if server is None:
                        raise ValueError("Serveur supprimé")
                    t.account = tpl.username
                    status, message = await push_one(db, tpl, server, update_existing)
                except Exception as e:  # noqa: BLE001
                    status, message = "failed", f"{type(e).__name__}: {e}"[:500]
                t.status, t.message, t.finished_at = status, message[:500], _now()
                db.add(AuditLog(user_id=user_id, server_id=server.id if server else None, action="account.push",
                                status="success" if status == "success" else ("failure" if status == "failed" else "info"),
                                result=f"{tpl.username if tpl else '?'}: {message}"[:500]))
                await db.commit()

    await asyncio.gather(*(one(tid) for tid in target_ids))
