from pydantic import BaseModel


class CommandRequest(BaseModel):
    command: str
    timeout: int = 30


class CommandResponse(BaseModel):
    exit_code: int
    stdout: str
    stderr: str


class ConnectionTestResponse(BaseModel):
    server_id: str
    server_name: str
    success: bool
    message: str
    latency_ms: float | None = None


class SystemInfoResponse(BaseModel):
    hostname: str
    os: str
    kernel: str
    uptime: str
    cpu_count: str
    memory_total: str
    memory_used: str
    disk_usage: str
