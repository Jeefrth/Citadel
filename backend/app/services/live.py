"""Live sessions registry (D4 / D5), shared by every backend process through Redis.

- citadel:live:sessions            set of active session ids
- citadel:live:meta:<id>           hash (user, server, account, protocol, ip, started, ...), TTL refreshed
- citadel:live:out:<id>            pub/sub channel: terminal output (base64)
- citadel:live:buf:<id>            list: last N output chunks for monitors joining late
- citadel:live:ctl:<id>            pub/sub channel: control messages (kill, monitor notices)
- citadel:live:watchers:<id>       set of admin display names currently watching
"""

import json
import time

import redis.asyncio as aioredis

from app.core import tenancy
from app.core.config import settings

PREFIX = "citadel:live:"
META_TTL = 90  # seconds; refreshed by the session's heartbeat

_client: aioredis.Redis | None = None


def redis() -> aioredis.Redis:
    global _client
    if _client is None:
        _client = aioredis.from_url(settings.REDIS_URL)
    return _client


async def register(session_id: str, meta: dict) -> None:
    r = redis()
    org = tenancy.current_org_id()
    meta = {**meta, "org_id": str(org) if org else meta.get("org_id"), "session_id": session_id, "started_at": meta.get("started_at") or time.time(),
            "last_activity": time.time()}
    await r.hset(f"{PREFIX}meta:{session_id}", mapping={k: json.dumps(v) for k, v in meta.items()})
    await r.expire(f"{PREFIX}meta:{session_id}", META_TTL)
    await r.sadd(f"{PREFIX}sessions", session_id)


async def heartbeat(session_id: str, **fields) -> None:
    r = redis()
    data = {"last_activity": time.time(), **fields}
    await r.hset(f"{PREFIX}meta:{session_id}", mapping={k: json.dumps(v) for k, v in data.items()})
    await r.expire(f"{PREFIX}meta:{session_id}", META_TTL)


async def unregister(session_id: str) -> None:
    r = redis()
    await r.srem(f"{PREFIX}sessions", session_id)
    await r.delete(f"{PREFIX}meta:{session_id}", f"{PREFIX}buf:{session_id}", f"{PREFIX}watchers:{session_id}")


async def get(session_id: str) -> dict | None:
    raw = await redis().hgetall(f"{PREFIX}meta:{session_id}")
    if not raw:
        return None
    meta = {k.decode(): json.loads(v) for k, v in raw.items()}
    # Inside an organisation, sessions of other organisations do not exist
    ctx = tenancy.current()
    if ctx is not None and not ctx.bypass and ctx.org_id is not None and meta.get("org_id") != str(ctx.org_id):
        return None
    meta["watchers"] = sorted(w.decode() for w in await redis().smembers(f"{PREFIX}watchers:{session_id}"))
    return meta


async def list_active() -> list[dict]:
    r = redis()
    out = []
    for sid in await r.smembers(f"{PREFIX}sessions"):
        sid = sid.decode()
        if not await r.exists(f"{PREFIX}meta:{sid}"):  # heartbeat stopped (crashed worker): clean the index
            await r.srem(f"{PREFIX}sessions", sid)
            continue
        meta = await get(sid)
        if meta is None:   # another organisation
            continue
        out.append(meta)
    return sorted(out, key=lambda m: m.get("started_at", 0))


async def publish_output(session_id: str, data_b64: str) -> None:
    r = redis()
    await r.publish(f"{PREFIX}out:{session_id}", data_b64)
    key = f"{PREFIX}buf:{session_id}"
    await r.rpush(key, data_b64)
    await r.ltrim(key, -settings.LIVE_BUFFER_CHUNKS, -1)
    await r.expire(key, META_TTL * 4)


async def buffered_output(session_id: str) -> list[str]:
    return [c.decode() for c in await redis().lrange(f"{PREFIX}buf:{session_id}", 0, -1)]


async def send_control(session_id: str, message: dict) -> int:
    return await redis().publish(f"{PREFIX}ctl:{session_id}", json.dumps(message))


async def add_watcher(session_id: str, name: str) -> None:
    await redis().sadd(f"{PREFIX}watchers:{session_id}", name)


async def remove_watcher(session_id: str, name: str) -> None:
    await redis().srem(f"{PREFIX}watchers:{session_id}", name)


def channel(kind: str, session_id: str) -> str:
    return f"{PREFIX}{kind}:{session_id}"
