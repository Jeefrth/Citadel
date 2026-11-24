import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.middleware import (
    SecurityHeadersMiddleware,
    RequestLoggingMiddleware,
    RateLimitMiddleware,
)
from app.api import auth, servers, users, commands, updates, monitoring, sessions, ca, admin, pam, secrets, governance, audit
from app.websocket import terminal, rdp, monitor

# Structured logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-5s [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

@asynccontextmanager
async def lifespan(_app: FastAPI):
    stop = asyncio.Event()
    tasks = []
    if settings.SCHEDULER_ENABLED and not settings.DEV_MODE:
        from app.services.scheduler import scheduler_loop
        tasks.append(asyncio.create_task(scheduler_loop(stop)))
    from app.services.siem import siem_loop
    tasks.append(asyncio.create_task(siem_loop(stop)))  # SIEM export runs even in dev mode
    yield
    stop.set()
    for task in tasks:
        task.cancel()


app = FastAPI(
    lifespan=lifespan,
    title="Citadel API",
    description="API de gestion centralisée de serveurs Windows et Linux",
    version="0.1.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

# Middleware stack (order matters: last added = first executed)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(RequestLoggingMiddleware)
app.add_middleware(RateLimitMiddleware, max_requests=200, window_seconds=60)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(servers.router, prefix="/api/servers", tags=["servers"])
app.include_router(users.router, prefix="/api/users", tags=["users"])
app.include_router(commands.router, prefix="/api/servers", tags=["commands"])
app.include_router(updates.router, prefix="/api/servers", tags=["updates"])
app.include_router(monitoring.router, prefix="/api", tags=["monitoring"])
app.include_router(sessions.router, prefix="/api/sessions", tags=["sessions"])
app.include_router(ca.router, prefix="/api/ca", tags=["ca"])
app.include_router(admin.router, prefix="/api/admin", tags=["admin"])
app.include_router(pam.router, prefix="/api", tags=["pam"])
app.include_router(secrets.router, prefix="/api", tags=["secrets"])
app.include_router(governance.router, prefix="/api", tags=["governance"])
app.include_router(audit.router, prefix="/api", tags=["audit"])
app.include_router(terminal.router, tags=["terminal"])
app.include_router(rdp.router, tags=["rdp"])
app.include_router(monitor.router, tags=["monitor"])


@app.get("/api/health")
async def health_check():
    return {"status": "ok", "version": "0.1.0"}
