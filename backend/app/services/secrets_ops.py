"""Account secret lifecycle: rotation (B3), discovery (B5), verification (B6).

Rotation flow (passwords only, local OS accounts):
  1. generate a new password and persist it encrypted as a PENDING
     SecretHistory row (commit), so it can never be lost;
  2. change it on the target through the server's default (privileged)
     account: `chpasswd` via stdin on Linux, Set-LocalUser on Windows;
  3. on success, activate it (credential updated, previous secret RETIRED),
     then verify a login with it; on failure mark the row FAILED and keep
     the old secret.
A credential shared by several accounts is never rotated in place: the
account first gets its own dedicated credential.
"""

import json
import logging
import secrets
import string
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.permissions import ResolvedAccount, account_auth, account_to_resolved
from app.core.security import encrypt_value
from app.models.audit import AuditLog
from app.models.base import CredentialType, OSType
from app.models.credential import Credential
from app.models.pam import Account, DiscoveredAccount, SecretHistory, SecretStatus
from app.models.server import Server
from app.services import ssh_service, winrm_service

logger = logging.getLogger("citadel.secrets")

HISTORY_KEEP = 5
# No quotes, backslash, space, $ or backtick: safe inside chpasswd input and
# single-quoted PowerShell strings, accepted by Windows complexity rules.
PASSWORD_SYMBOLS = "-_.@%+=!#*"
PASSWORD_ALPHABET = string.ascii_letters + string.digits + PASSWORD_SYMBOLS


def generate_password(length: int = 24) -> str:
    """Random password with at least one char of each class."""
    if length < 12:
        raise ValueError("Password length must be >= 12")
    while True:
        pw = "".join(secrets.choice(PASSWORD_ALPHABET) for _ in range(length))
        if (any(c.islower() for c in pw) and any(c.isupper() for c in pw)
                and any(c.isdigit() for c in pw) and any(c in PASSWORD_SYMBOLS for c in pw)):
            return pw


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _short(msg: str, n: int = 480) -> str:
    return (msg or "").strip().replace("\n", " ")[:n]


@dataclass
class OpResult:
    ok: bool
    message: str


# ── Low-level target operations ─────────────────────────


def _auth_kwargs(server: Server, acc: ResolvedAccount) -> dict:
    if acc.use_cert:
        return {"use_ephemeral_cert": True, "cert_validity_minutes": 1}
    if server.os_type == OSType.WINDOWS:
        return {"password": acc.password}
    return {"password": acc.password, "ssh_key": acc.ssh_key}


async def _test_login(server: Server, acc: ResolvedAccount) -> tuple[bool, str]:
    if server.os_type == OSType.LINUX:
        return await ssh_service.test_connection(
            host=server.ip_address, port=server.ssh_port, username=acc.username, **_auth_kwargs(server, acc))
    if acc.use_cert or not acc.password:
        return False, "Windows verification needs a password account"
    return await winrm_service.test_connection(
        host=server.ip_address, port=server.winrm_port, username=acc.username, password=acc.password)


async def _run(server: Server, executor: ResolvedAccount, command: str, stdin: str | None = None, timeout: int = 60):
    if server.os_type == OSType.LINUX:
        return await ssh_service.execute_command(
            host=server.ip_address, port=server.ssh_port, username=executor.username,
            command=command, timeout=timeout, stdin=stdin, **_auth_kwargs(server, executor))
    if stdin is not None:
        raise ValueError("stdin is not supported over WinRM")
    return await winrm_service.execute_command(
        host=server.ip_address, port=server.winrm_port, username=executor.username,
        command=command, timeout=timeout, password=executor.password)


def _executor(server: Server) -> ResolvedAccount:
    acc = server.default_account
    if acc is None:
        raise ValueError("No default (privileged) account configured on this server")
    return account_to_resolved(acc)


async def _change_password_on_target(server: Server, executor: ResolvedAccount, username: str, new_password: str) -> OpResult:
    if server.os_type == OSType.LINUX:
        cmd = "chpasswd" if executor.username == "root" else "sudo -n chpasswd"
        res = await _run(server, executor, cmd, stdin=f"{username}:{new_password}\n")
    else:
        # Local accounts only. Note: PowerShell script block logging (event 4104)
        # may record this script on the target; see docs/vault.md.
        script = (
            f"$p = ConvertTo-SecureString '{new_password}' -AsPlainText -Force; "
            f"Set-LocalUser -Name '{username}' -Password $p -ErrorAction Stop; Write-Output 'rotated'"
        )
        res = await _run(server, executor, script)
    if res.exit_code == 0:
        return OpResult(True, "password changed on target")
    return OpResult(False, _short(res.stderr or res.stdout or f"exit code {res.exit_code}"))


# ── Rotation (B3) ───────────────────────────────────────


async def _dedicated_credential(db: AsyncSession, account: Account, server: Server) -> Credential:
    """Return a credential used by this account only (detach shared ones)."""
    cred = account.credential
    users = (await db.execute(select(func.count(Account.id)).where(Account.credential_id == cred.id))).scalar_one()
    if users <= 1:
        return cred
    dedicated = Credential(
        name=f"{server.name}/{account.username}",
        type=cred.type,
        username=account.username,
        encrypted_password=cred.encrypted_password,
    )
    db.add(dedicated)
    await db.flush()
    account.credential_id = dedicated.id
    account.credential = dedicated
    return dedicated


def rotation_blocker(account: Account) -> str | None:
    """Why this account cannot be rotated, or None."""
    auth = account_auth(account)
    if auth == "cert":
        return "Ephemeral certificate accounts have no secret to rotate"
    if auth == "ssh_key":
        return "SSH key rotation is not supported yet (passwords only)"
    if auth != "password":
        return "Account has no password credential"
    return None


async def rotate_account(db: AsyncSession, account: Account, actor_id=None, reason: str = "manual") -> OpResult:
    server = (await db.execute(select(Server).where(Server.id == account.server_id))).scalar_one()
    blocker = rotation_blocker(account)
    if blocker:
        return OpResult(False, blocker)
    try:
        executor = _executor(server)
    except ValueError as e:
        return OpResult(False, str(e))

    new_password = generate_password()
    pending = SecretHistory(
        account_id=account.id, encrypted_secret=encrypt_value(new_password),
        status=SecretStatus.PENDING.value, reason=reason, actor_id=actor_id,
    )
    db.add(pending)
    await db.commit()  # persisted before touching the target

    try:
        change = await _change_password_on_target(server, executor, account.username, new_password)
    except Exception as e:  # noqa: BLE001 - network / auth errors
        change = OpResult(False, f"{type(e).__name__}: {e}")

    if not change.ok:
        pending.status = SecretStatus.FAILED.value
        pending.error = _short(change.message)
        account.last_rotation_status = "failed"
        account.last_rotation_message = _short(change.message)
        await _audit(db, actor_id, server.id, "account.rotate", "failure",
                     f"{account.username}: {_short(change.message, 200)}")
        from app.services.notifications import notify
        await notify(db, "rotation.failed", f"Échec de rotation : {account.username}@{server.name}",
                     _short(change.message, 300), link=f"/servers/{server.id}", level="critical")
        await db.commit()
        return OpResult(False, f"Rotation failed: {change.message}")

    # Activate: the target already uses the new password, store it now
    cred = await _dedicated_credential(db, account, server)
    cred.encrypted_password = pending.encrypted_secret
    previous = (await db.execute(select(SecretHistory).where(
        SecretHistory.account_id == account.id, SecretHistory.status == SecretStatus.ACTIVE.value,
    ))).scalars().all()
    for p in previous:
        p.status = SecretStatus.RETIRED.value
    pending.status = SecretStatus.ACTIVE.value
    pending.activated_at = _now()
    account.last_rotated_at = _now()
    account.last_rotation_status = "ok"
    account.last_rotation_message = None
    await _audit(db, actor_id, server.id, "account.rotate", "success", f"{account.username} ({reason})")
    await db.commit()
    await _prune_history(db, account.id)

    # Verify with the new secret (informational: the change already happened)
    verify = await verify_account(db, account)
    msg = "Password rotated" + ("" if verify.ok else f", but verification failed: {verify.message}")
    return OpResult(True, msg)


async def _prune_history(db: AsyncSession, account_id) -> None:
    rows = (await db.execute(
        select(SecretHistory).where(SecretHistory.account_id == account_id)
        .order_by(SecretHistory.created_at.desc())
    )).scalars().all()
    for old in rows[HISTORY_KEEP:]:
        if old.status != SecretStatus.ACTIVE.value:
            await db.delete(old)
    await db.commit()


# ── Verification (B6) ───────────────────────────────────


async def verify_account(db: AsyncSession, account: Account) -> OpResult:
    server = (await db.execute(select(Server).where(Server.id == account.server_id))).scalar_one()
    try:
        resolved = account_to_resolved(account)
        ok, message = await _test_login(server, resolved)
        status = "ok" if ok else "failed"
    except Exception as e:  # noqa: BLE001
        ok, message, status = False, f"{type(e).__name__}: {getattr(e, 'detail', e)}", "error"
    account.verify_status = status
    account.verify_message = None if ok else _short(message)
    account.last_verified_at = _now()
    await db.commit()
    return OpResult(ok, message)


# ── Discovery (B5) ──────────────────────────────────────

LINUX_DISCOVERY_CMD = (
    "getent passwd; echo '---GROUPS---'; "
    "getent group sudo wheel admin 2>/dev/null; echo '---LASTLOG---'; "
    "lastlog 2>/dev/null | tail -n +2 || true"
)
NOLOGIN_SHELLS = ("nologin", "/false", "/sync", "/shutdown", "/halt")

WINDOWS_DISCOVERY_PS = (
    "$admins = @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction SilentlyContinue | "
    "ForEach-Object { ($_.Name -split '\\\\')[-1] }); "
    "Get-LocalUser | ForEach-Object { [pscustomobject]@{ "
    "name = $_.Name; sid = $_.SID.Value; enabled = $_.Enabled; "
    "last = $(if ($_.LastLogon) { $_.LastLogon.ToString('s') } else { $null }); "
    "admin = ($admins -contains $_.Name) } } | ConvertTo-Json -Compress"
)


def parse_linux_accounts(output: str) -> list[dict]:
    """Interactive accounts only: uid 0 or uid >= 1000 with a login shell."""
    passwd, _, rest = output.partition("---GROUPS---")
    groups, _, lastlog = rest.partition("---LASTLOG---")
    privileged: set[str] = set()
    for line in groups.strip().splitlines():
        parts = line.split(":")
        if len(parts) >= 4 and parts[3]:
            privileged.update(u.strip() for u in parts[3].split(",") if u.strip())
    last: dict[str, str] = {}
    for line in lastlog.strip().splitlines():
        cols = line.split(None, 1)
        if len(cols) == 2 and "**Never logged in**" not in cols[1]:
            last[cols[0]] = _short(cols[1], 100)
    accounts = []
    for line in passwd.strip().splitlines():
        parts = line.split(":")
        if len(parts) < 7:
            continue
        name, uid, shell = parts[0], parts[2], parts[6]
        try:
            uid_n = int(uid)
        except ValueError:
            continue
        if uid_n != 0 and uid_n < 1000:
            continue
        if uid_n == 65534 or any(shell.endswith(s) for s in NOLOGIN_SHELLS):
            continue
        accounts.append({
            "username": name, "uid": uid, "shell": shell, "enabled": True,
            "privileged": uid_n == 0 or name in privileged, "last_login": last.get(name),
        })
    return accounts


def parse_windows_accounts(output: str) -> list[dict]:
    output = (output or "").strip()
    if not output:
        return []
    data = json.loads(output)
    if isinstance(data, dict):
        data = [data]
    return [{
        "username": d["name"], "uid": d.get("sid"), "shell": None,
        "enabled": bool(d.get("enabled")), "privileged": bool(d.get("admin")),
        "last_login": d.get("last"),
    } for d in data]


async def discover_accounts(db: AsyncSession, server: Server) -> OpResult:
    try:
        executor = _executor(server)
        if server.os_type == OSType.LINUX:
            res = await _run(server, executor, LINUX_DISCOVERY_CMD)
            found = parse_linux_accounts(res.stdout)
        else:
            res = await _run(server, executor, WINDOWS_DISCOVERY_PS)
            if res.exit_code != 0:
                return OpResult(False, _short(res.stderr or res.stdout))
            found = parse_windows_accounts(res.stdout)
    except Exception as e:  # noqa: BLE001
        return OpResult(False, f"{type(e).__name__}: {getattr(e, 'detail', e)}")

    existing = {d.username: d for d in (await db.execute(
        select(DiscoveredAccount).where(DiscoveredAccount.server_id == server.id))).scalars().all()}
    now = _now()
    seen = set()
    new_count = 0
    managed = {a.username for a in server.accounts}
    new_privileged: list[str] = []
    for item in found:
        seen.add(item["username"])
        row = existing.get(item["username"])
        if row is None:
            row = DiscoveredAccount(server_id=server.id, username=item["username"], first_seen=now)
            db.add(row)
            new_count += 1
            if item["privileged"] and item["username"] not in managed:
                new_privileged.append(item["username"])
        elif row.status == "gone":
            row.status = "new"
        for k in ("uid", "shell", "enabled", "privileged", "last_login"):
            setattr(row, k, item[k])
        row.last_seen = now
    for name, row in existing.items():
        if name not in seen and row.status != "gone":
            row.status = "gone"
    server.accounts_discovered_at = now
    if new_privileged:
        from app.services.notifications import notify
        await notify(db, "discovery.privileged", f"Compte(s) privilégié(s) non géré(s) sur {server.name}",
                     ", ".join(new_privileged), link=f"/servers/{server.id}", level="warning")
    await db.commit()
    return OpResult(True, f"{len(found)} account(s) found, {new_count} new")


async def _audit(db: AsyncSession, actor_id, server_id, action: str, status: str, result: str) -> None:
    user_id = actor_id or await _system_user_id(db)
    if user_id is None:
        logger.info("audit (no user): %s %s %s", action, status, result)
        return
    db.add(AuditLog(user_id=user_id, server_id=server_id, action=action, status=status, result=result))


async def _system_user_id(db: AsyncSession):
    """AuditLog.user_id is mandatory: attribute scheduled jobs to the first admin."""
    from app.models.base import UserRole
    from app.models.user import User
    row = (await db.execute(
        select(User.id).where(User.role == UserRole.ADMIN).order_by(User.created_at).limit(1)
    )).first()
    return row[0] if row else None
