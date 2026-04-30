"""Security middleware: rate limiting, request logging, security headers.

Uses raw ASGI middleware (not BaseHTTPMiddleware) to avoid WebSocket issues.
"""

import time
import logging
from collections import defaultdict

from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger("citadel")


class SecurityHeadersMiddleware:
    """Add security headers to all HTTP responses (not WebSocket)."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = dict(message.get("headers", []))
                extra = [
                    (b"x-content-type-options", b"nosniff"),
                    (b"x-frame-options", b"DENY"),
                    (b"x-xss-protection", b"1; mode=block"),
                    (b"referrer-policy", b"strict-origin-when-cross-origin"),
                    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
                ]
                existing = list(message.get("headers", []))
                existing.extend(extra)
                message["headers"] = existing
            await send(message)

        await self.app(scope, receive, send_with_headers)


class RequestLoggingMiddleware:
    """Log all HTTP API requests with timing (not WebSocket)."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request = Request(scope)
        if request.url.path == "/api/health":
            await self.app(scope, receive, send)
            return

        start = time.time()
        status_code = 0

        async def send_with_logging(message):
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
            await send(message)

        await self.app(scope, receive, send_with_logging)

        elapsed = (time.time() - start) * 1000
        client_ip = request.client.host if request.client else "unknown"
        logger.info(
            "request",
            extra={
                "method": request.method,
                "path": request.url.path,
                "status": status_code,
                "duration_ms": round(elapsed, 1),
                "client_ip": client_ip,
            },
        )


class RateLimitMiddleware:
    """Simple in-memory rate limiter per IP (HTTP only, not WebSocket)."""

    def __init__(self, app: ASGIApp, max_requests: int = 200, window_seconds: int = 60):
        self.app = app
        self.max_requests = max_requests
        self.window = window_seconds
        self._requests: dict[str, list[float]] = defaultdict(list)

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request = Request(scope)
        client_ip = request.client.host if request.client else "unknown"
        now = time.time()

        self._requests[client_ip] = [
            t for t in self._requests[client_ip] if t > now - self.window
        ]

        if len(self._requests[client_ip]) >= self.max_requests:
            response = Response(
                content='{"detail":"Rate limit exceeded"}',
                status_code=429,
                media_type="application/json",
                headers={"Retry-After": str(self.window)},
            )
            await response(scope, receive, send)
            return

        self._requests[client_ip].append(now)
        await self.app(scope, receive, send)
