"""Tests for FastAPI application setup and health endpoint."""

import pytest
from httpx import AsyncClient, ASGITransport

from app.main import app


@pytest.fixture
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


async def test_health_check(client):
    response = await client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "version" in data


async def test_auth_me_requires_token(client):
    response = await client.get("/api/auth/me")
    assert response.status_code == 403  # No bearer token


async def test_servers_list_requires_token(client):
    response = await client.get("/api/servers/")
    assert response.status_code == 403


async def test_users_list_requires_token(client):
    response = await client.get("/api/users/")
    assert response.status_code == 403
