"""Command journal (D3): one row per command run through Citadel."""

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit_trail import CommandLog


async def log_command(
    db: AsyncSession, *, user, server, account: str | None, command: str, source: str,
    decision: str, rule: str | None = None, session_id: str | None = None,
    offset_ms: int | None = None, exit_code: int | None = None, ip: str | None = None,
) -> None:
    db.add(CommandLog(
        session_id=session_id, user_id=user.id, server_id=(None if getattr(server, "is_k8s", False) else server.id) if server else None,
        user_name=user.display_name, server_name=server.name if server else "",
        account=account, command=command[:10000], source=source, decision=decision, rule=rule,
        exit_code=exit_code, offset_ms=offset_ms, ip_address=ip,
    ))
    await db.commit()
