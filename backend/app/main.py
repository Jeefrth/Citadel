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
from app.api import auth, servers, users, commands, updates, monitoring, sessions, ca, admin, pam, secrets, governance, audit, operations, identity, reports, backups, applications, risks, roles, kubernetes
from app.websocket import terminal, rdp, monitor, k8s_exec

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
    try:
        from app.services.jobs import mark_interrupted
        await mark_interrupted()  # jobs cut by a restart cannot resume
    except Exception:  # noqa: BLE001 - DB may not be migrated yet
        logging.getLogger("citadel").warning("could not clean interrupted jobs")
    if settings.SCHEDULER_ENABLED and not settings.DEV_MODE:
        from app.services.scheduler import scheduler_loop
        tasks.append(asyncio.create_task(scheduler_loop(stop)))
    from app.services.siem import siem_loop
    tasks.append(asyncio.create_task(siem_loop(stop)))  # SIEM export runs even in dev mode
    if settings.SSH_PROXY_ENABLED:
        from app.services.ssh_proxy import serve

        async def _proxy():
            try:
                await serve(stop)
            except Exception:  # noqa: BLE001 - never take the API down with it
                logging.getLogger("citadel.ssh_proxy").exception("SSH proxy failed to start")
        tasks.append(asyncio.create_task(_proxy()))
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
app.include_router(operations.router, prefix="/api", tags=["operations"])
app.include_router(identity.router, prefix="/api", tags=["identity"])
app.include_router(reports.router, prefix="/api", tags=["reports"])
app.include_router(backups.router, prefix="/api", tags=["backups"])
app.include_router(applications.router, prefix="/api", tags=["applications"])
app.include_router(risks.router, prefix="/api", tags=["risks"])
app.include_router(roles.router, prefix="/api", tags=["roles"])
app.include_router(kubernetes.router, prefix="/api", tags=["kubernetes"])
app.include_router(terminal.router, tags=["terminal"])
app.include_router(rdp.router, tags=["rdp"])
app.include_router(monitor.router, tags=["monitor"])
app.include_router(k8s_exec.router, tags=["kubernetes"])


@app.get("/api/health")
async def health_check():
    return {"status": "ok", "version": "0.1.0"}
