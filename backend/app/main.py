from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.api import auth, servers, users, commands, updates, monitoring
from app.websocket import terminal

app = FastAPI(
    title="srv_gest API",
    description="API de gestion centralisée de serveurs Windows et Linux",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(servers.router, prefix="/api/servers", tags=["servers"])
app.include_router(users.router, prefix="/api/users", tags=["users"])
app.include_router(commands.router, prefix="/api/servers", tags=["commands"])
app.include_router(updates.router, prefix="/api/servers", tags=["updates"])
app.include_router(monitoring.router, prefix="/api", tags=["monitoring"])
app.include_router(terminal.router, tags=["terminal"])


@app.get("/api/health")
async def health_check():
    return {"status": "ok", "version": "0.1.0"}
