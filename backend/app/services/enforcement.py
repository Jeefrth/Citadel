"""Single enforcement point for connection and command ACLs (C3, C5, G2).

Used by the terminal WebSocket, the RDP connect-ticket and the execute API,
so every entry point applies exactly the same rules.
"""

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.governance import evaluate_command, evaluate_connection, find_grant, request_approval
from app.models.audit import AuditLog
from app.models.governance import ApprovalKind, CommandAction, ConnectAction, RuleScope
from app.models.server import Server
from app.models.user import User
from app.services.approvals import consume_command_grant
from app.services.notifications import notify


class GovernanceDenied(Exception):
    """Refused by a rule, or waiting for an approval. `message` is user-facing (FR)."""

    def __init__(self, message: str, approval_number: int | None = None):
        super().__init__(message)
        self.message = message
        self.approval_number = approval_number


async def enforce_connect(
    db: AsyncSession, user: User, server: Server, account: str, ip: str | None, reason: str | None = None,
) -> None:
    decision = await evaluate_connection(db, user, RuleScope.CONNECT.value, ip, server=server, account=account)
    if decision.action == ConnectAction.ALLOW.value:
        return
    if decision.action == ConnectAction.DENY.value:
        db.add(AuditLog(user_id=user.id, server_id=server.id, action="connect.denied", status="failure",
                        ip_address=ip, result=f"account={account} rule={decision.rule}"))
        await notify(db, "connect.denied", f"Connexion refusée : {user.display_name} sur {server.name}",
                     f"Compte {account}, IP {ip or '?'}, règle « {decision.rule} ».",
                     link=f"/servers/{server.id}", level="warning")
        await db.commit()
        raise GovernanceDenied(f"Connexion refusée par la règle « {decision.rule} ».")
    # review
    if await find_grant(db, user, ApprovalKind.CONNECT.value, server.id, account):
        return
    req = await request_approval(db, user, ApprovalKind.CONNECT.value, decision, server=server,
                                 account=account, reason=reason)
    db.add(AuditLog(user_id=user.id, server_id=server.id, action="connect.review", status="pending",
                    ip_address=ip, result=f"#{req.number} account={account} rule={decision.rule}"))
    await db.commit()
    raise GovernanceDenied(
        f"Connexion soumise à validation (demande #{req.number}). "
        f"Vous pourrez vous connecter dès qu'un valideur l'aura approuvée.", req.number)


@dataclass
class CommandOutcome:
    allowed: bool
    message: str | None = None
    approval_number: int | None = None
    decision: str = "allowed"   # allowed | alert | denied | review | approved_run
    rule: str | None = None


async def check_command(
    db: AsyncSession, user: User, server: Server, account: str, command: str, ip: str | None,
    source: str = "execute",
) -> CommandOutcome:
    """Decide a command. ALERT runs (admins notified), REVIEW needs a one-shot approval."""
    cmd = command.strip()
    decision = await evaluate_command(db, user, server, account, cmd)

    if decision.action == CommandAction.ALLOW.value:
        return CommandOutcome(True, rule=decision.rule)

    if decision.action == CommandAction.ALERT.value:
        db.add(AuditLog(user_id=user.id, server_id=server.id, action="command.alert", command=cmd,
                        ip_address=ip, result=f"{source} account={account} rule={decision.rule}"))
        await notify(db, "command.alert", f"Commande surveillée sur {server.name}",
                     f"{user.display_name} ({account}) : {cmd}\nRègle « {decision.rule} ».",
                     link=f"/servers/{server.id}", level="warning")
        await db.commit()
        return CommandOutcome(True, decision="alert", rule=decision.rule)

    if decision.action == CommandAction.DENY.value:
        db.add(AuditLog(user_id=user.id, server_id=server.id, action="command.denied", status="failure",
                        command=cmd, ip_address=ip, result=f"{source} account={account} rule={decision.rule}"))
        await notify(db, "command.denied", f"Commande refusée sur {server.name}",
                     f"{user.display_name} ({account}) : {cmd}\nRègle « {decision.rule} ».",
                     link=f"/servers/{server.id}", level="warning")
        await db.commit()
        return CommandOutcome(False, f"Commande refusée par la règle « {decision.rule} ».",
                              decision="denied", rule=decision.rule)

    # review: one-shot grant for this exact command
    grant = await find_grant(db, user, ApprovalKind.COMMAND.value, server.id, account, command=cmd)
    if grant:
        await consume_command_grant(db, grant)
        db.add(AuditLog(user_id=user.id, server_id=server.id, action="command.approved_run", command=cmd,
                        ip_address=ip, result=f"#{grant.number} {source} account={account}"))
        await db.commit()
        return CommandOutcome(True, decision="approved_run", rule=decision.rule)
    req = await request_approval(db, user, ApprovalKind.COMMAND.value, decision, server=server,
                                 account=account, command=cmd)
    db.add(AuditLog(user_id=user.id, server_id=server.id, action="command.review", status="pending",
                    command=cmd, ip_address=ip, result=f"#{req.number} {source} rule={decision.rule}"))
    await db.commit()
    return CommandOutcome(
        False,
        f"Commande soumise à validation (demande #{req.number}). Relancez-la à l'identique une fois approuvée.",
        req.number, decision="review", rule=decision.rule,
    )
