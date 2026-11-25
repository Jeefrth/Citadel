"""SIEM export (D9).

Outbox-style forwarder: for each active target and stream (audit logs,
command journal), events newer than the target's persisted cursor are sent
in batches, then the cursor advances. Delivery is at-least-once and survives
restarts; a Redis lock keeps one forwarder active across workers.

Formats:
- json : one JSON object per event (syslog MSG, or JSON array over HTTP)
- cef  : ArcSight CEF (Microsoft Sentinel / QRadar via syslog)
- hec  : Splunk HTTP Event Collector envelope (Splunk, CrowdStrike NG-SIEM / LogScale)
Transports: syslog over udp / tcp / tls (RFC 5424, octet-counting framing), http.
"""

import asyncio
import json
import logging
import socket
import ssl
from datetime import datetime, timezone

import httpx
import redis.asyncio as aioredis
from sqlalchemy import and_, or_, select

from app.core.config import settings
from app.core.database import async_session
from app.core.security import decrypt_value
from app.models.audit import AuditLog
from app.models.audit_trail import CommandLog, SiemTarget
from app.models.user import User

logger = logging.getLogger("citadel.siem")
BATCH = 500
LOCK_KEY = "citadel:siem:lock"
VENDOR, PRODUCT, VERSION = "Citadel", "Citadel PAM", "0.1.0"

SEVERITY = {  # CEF 0-10 / syslog severity
    "command.denied": (7, 4), "connect.denied": (7, 4), "login.denied": (7, 4),
    "command.alert": (6, 4), "command.review": (5, 5), "connect.review": (5, 5),
    "account.rotate": (3, 6), "session.monitor": (5, 5), "session.kill": (7, 4),
}


# ── Event building ───────────────────────────────────────


def audit_event(a: AuditLog, user_names: dict) -> dict:
    return {
        "stream": "audit", "id": str(a.id), "timestamp": a.timestamp.isoformat(),
        "action": a.action, "status": a.status, "user_id": str(a.user_id),
        "user": user_names.get(str(a.user_id)), "server_id": str(a.server_id) if a.server_id else None,
        "server": a.server.name if a.server else None,
        "command": a.command, "result": a.result, "src_ip": a.ip_address,
    }


def command_event(c: CommandLog) -> dict:
    return {
        "stream": "commands", "id": str(c.id), "timestamp": c.created_at.isoformat(),
        "action": f"command.{c.decision}", "status": "success" if c.decision in ("allowed", "alert", "approved_run") else "failure",
        "user_id": str(c.user_id), "user": c.user_name, "server_id": str(c.server_id) if c.server_id else None,
        "server": c.server_name, "account": c.account, "command": c.command, "source": c.source,
        "decision": c.decision, "rule": c.rule, "exit_code": c.exit_code, "session_id": c.session_id,
        "src_ip": c.ip_address,
    }


def _cef_escape_header(v: str) -> str:
    return str(v).replace("\\", "\\\\").replace("|", "\\|")


def _cef_escape_ext(v) -> str:
    return str(v).replace("\\", "\\\\").replace("=", "\\=").replace("\r", " ").replace("\n", " ")


def to_cef(e: dict) -> str:
    sev = SEVERITY.get(e["action"], (3, 6))[0]
    ts = int(datetime.fromisoformat(e["timestamp"]).timestamp() * 1000)
    ext = {
        "rt": ts, "suser": e.get("user"), "duser": e.get("account"), "dhost": e.get("server"),
        "src": e.get("src_ip"), "act": e.get("decision") or e.get("status"), "outcome": e.get("status"),
        "msg": e.get("result"), "externalId": e["id"],
    }
    for i, (label, key) in enumerate((("command", "command"), ("rule", "rule"), ("session", "session_id")), 1):
        if e.get(key):  # custom string + its label only when there is a value
            ext[f"cs{i}Label"], ext[f"cs{i}"] = label, e[key]
    ext_str = " ".join(f"{k}={_cef_escape_ext(v)}" for k, v in ext.items() if v not in (None, ""))
    return (f"CEF:0|{_cef_escape_header(VENDOR)}|{_cef_escape_header(PRODUCT)}|{VERSION}|"
            f"{_cef_escape_header(e['action'])}|{_cef_escape_header(e['action'])}|{sev}|{ext_str}")


def to_syslog(e: dict, fmt: str) -> bytes:
    """RFC 5424 line: <PRI>1 TIMESTAMP HOST APP - MSGID - MSG"""
    severity = SEVERITY.get(e["action"], (3, 6))[1]
    pri = 10 * 8 + severity  # facility 10 = authpriv
    msg = to_cef(e) if fmt == "cef" else json.dumps(e, ensure_ascii=False, default=str)
    host = socket.gethostname()
    line = f"<{pri}>1 {e['timestamp']} {host} citadel - {e['action'][:32]} - {msg}"
    return line.encode("utf-8")


def http_body(events: list[dict], fmt: str, cfg: dict) -> tuple[bytes, str]:
    if fmt == "hec":
        lines = [json.dumps({
            "time": datetime.fromisoformat(e["timestamp"]).timestamp(),
            "host": "citadel", "source": "citadel", "sourcetype": cfg.get("sourcetype") or "citadel:audit",
            **({"index": cfg["index"]} if cfg.get("index") else {}),
            "event": e,
        }, default=str) for e in events]
        return "\n".join(lines).encode(), "application/json"
    if fmt == "cef":
        return "\n".join(to_cef(e) for e in events).encode(), "text/plain"
    return json.dumps(events, default=str).encode(), "application/json"


# ── Transports ───────────────────────────────────────────


async def send(target: SiemTarget, events: list[dict]) -> None:
    if not events:
        return
    cfg = target.config or {}
    secret = decrypt_value(target.encrypted_secret) if target.encrypted_secret else None
    if target.transport == "http":
        body, ctype = http_body(events, target.format, cfg)
        headers = {"Content-Type": ctype}
        if secret:
            headers["Authorization"] = f"Splunk {secret}" if target.format == "hec" and not cfg.get("bearer") else f"Bearer {secret}"
        async with httpx.AsyncClient(timeout=20, verify=cfg.get("verify_tls", True)) as c:
            r = await c.post(cfg["url"], content=body, headers=headers)
            if r.status_code >= 300:
                raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
        return

    host, port = cfg["host"], int(cfg.get("port") or (6514 if target.transport == "tls" else 514))
    lines = [to_syslog(e, target.format) for e in events]
    if target.transport == "udp":
        loop = asyncio.get_running_loop()
        transport, _ = await loop.create_datagram_endpoint(asyncio.DatagramProtocol, remote_addr=(host, port))
        try:
            for line in lines:
                transport.sendto(line[:65000])
        finally:
            transport.close()
        return
    ctx = None
    if target.transport == "tls":
        ctx = ssl.create_default_context()
        if not cfg.get("verify_tls", True):
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
    reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port, ssl=ctx), timeout=10)
    try:
        for line in lines:  # RFC 6587 octet counting
            writer.write(f"{len(line)} ".encode() + line)
        await writer.drain()
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass


# ── Forwarder ────────────────────────────────────────────


def _cursor_filter(model_ts, model_id, cursor: dict | None):
    if not cursor:
        return None
    ts = datetime.fromisoformat(cursor["ts"])
    return or_(model_ts > ts, and_(model_ts == ts, model_id > cursor["id"]))


async def forward_once(db, target: SiemTarget) -> int:
    from sqlalchemy.orm import selectinload

    sent = 0
    cursors = dict(target.cursors or {})
    from app.services.members import names as _member_names
    user_names = {str(i): n for i, n in (await _member_names(db)).items()}
    for stream in target.streams or []:
        if stream == "audit":
            q = select(AuditLog).options(selectinload(AuditLog.server)).order_by(AuditLog.timestamp, AuditLog.id)
            f = _cursor_filter(AuditLog.timestamp, AuditLog.id, cursors.get("audit"))
            rows = (await db.execute((q.where(f) if f is not None else q).limit(BATCH))).scalars().all()
            events = [audit_event(a, user_names) for a in rows]
            last = (rows[-1].timestamp, rows[-1].id) if rows else None
        elif stream == "commands":
            q = select(CommandLog).order_by(CommandLog.created_at, CommandLog.id)
            f = _cursor_filter(CommandLog.created_at, CommandLog.id, cursors.get("commands"))
            rows = (await db.execute((q.where(f) if f is not None else q).limit(BATCH))).scalars().all()
            events = [command_event(c) for c in rows]
            last = (rows[-1].created_at, rows[-1].id) if rows else None
        else:
            continue
        if not events:
            continue
        await send(target, events)
        cursors[stream] = {"ts": last[0].isoformat(), "id": str(last[1])}
        sent += len(events)
    if sent:
        target.cursors = cursors
        target.sent_count = (target.sent_count or 0) + sent
        target.last_sent_at = datetime.now(timezone.utc)
    target.last_error = None
    await db.commit()
    return sent


async def siem_loop(stop: asyncio.Event) -> None:
    client = aioredis.from_url(settings.REDIS_URL)
    await asyncio.sleep(10)
    while not stop.is_set():
        try:
            if await client.set(LOCK_KEY, "1", nx=True, ex=30):
                try:
                    async with async_session() as db:
                        targets = (await db.execute(select(SiemTarget).where(SiemTarget.is_active.is_(True)))).scalars().all()
                        for t in targets:
                            try:
                                while await forward_once(db, t) >= BATCH:
                                    pass  # drain backlog
                            except Exception as e:  # noqa: BLE001
                                await db.rollback()
                                t = await db.get(SiemTarget, t.id)
                                t.last_error = f"{type(e).__name__}: {e}"[:500]
                                await db.commit()
                                logger.warning("SIEM target %s failed: %s", t.name, t.last_error)
                finally:
                    await client.delete(LOCK_KEY)
        except Exception:  # noqa: BLE001
            logger.exception("SIEM loop error")
        try:
            await asyncio.wait_for(stop.wait(), timeout=5)
        except asyncio.TimeoutError:
            pass
    await client.aclose()
