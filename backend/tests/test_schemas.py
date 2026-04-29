"""Tests for Pydantic schemas validation."""

import uuid
from datetime import datetime

import pytest

from app.schemas.server import ServerCreate, ServerUpdate, ServerRead
from app.schemas.credential import CredentialCreate
from app.schemas.user import UserUpdate
from app.schemas.command import CommandRequest
from app.models.base import OSType, ServerStatus, CredentialType, UserRole


def test_server_create_valid():
    data = ServerCreate(
        name="web-01",
        hostname="web-01.local",
        ip_address="192.168.1.10",
        os_type=OSType.LINUX,
    )
    assert data.name == "web-01"
    assert data.ssh_port == 22  # default
    assert data.winrm_port == 5985  # default
    assert data.tags is None


def test_server_create_with_all_fields():
    data = ServerCreate(
        name="win-dc",
        hostname="dc01.corp.local",
        ip_address="10.0.0.5",
        os_type=OSType.WINDOWS,
        os_version="Windows Server 2022",
        ssh_port=22,
        winrm_port=5986,
        tags={"env": "prod", "role": "dc"},
        credential_id=uuid.uuid4(),
        group_id=uuid.uuid4(),
    )
    assert data.os_type == OSType.WINDOWS
    assert data.tags["env"] == "prod"


def test_server_update_partial():
    data = ServerUpdate(name="new-name")
    dumped = data.model_dump(exclude_unset=True)
    assert dumped == {"name": "new-name"}
    assert "ip_address" not in dumped


def test_credential_create_ssh_password():
    data = CredentialCreate(
        name="ssh-root",
        type=CredentialType.SSH_PASSWORD,
        username="root",
        password="secret123",
    )
    assert data.type == CredentialType.SSH_PASSWORD
    assert data.ssh_key is None


def test_credential_create_ssh_key():
    data = CredentialCreate(
        name="ssh-key",
        type=CredentialType.SSH_KEY,
        username="deploy",
        ssh_key="-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----",
    )
    assert data.type == CredentialType.SSH_KEY
    assert data.password is None


def test_user_update_role():
    data = UserUpdate(role=UserRole.ADMIN)
    assert data.role == UserRole.ADMIN
    assert data.is_active is None


def test_command_request_defaults():
    data = CommandRequest(command="ls -la")
    assert data.timeout == 30


def test_command_request_custom_timeout():
    data = CommandRequest(command="apt update", timeout=120)
    assert data.timeout == 120
