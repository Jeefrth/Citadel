"""Minimal OpenBao / HashiCorp Vault client (same HTTP API).

Used for:
- Transit engine: encrypt / decrypt / rewrap credential secrets. The key
  never leaves the vault; Postgres only stores "vault:vN:..." ciphertexts.
- SSH secrets engine: sign ephemeral user certificates (CA key in the vault).

Auth: AppRole (role_id + secret_id), token cached and renewed by re-login.
The client is synchronous on purpose: encrypt_value/decrypt_value are called
from sync code paths, and calls go to a vault on the same host (~ms).
"""

import base64
import logging
import threading
import time
from pathlib import Path

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


class VaultError(RuntimeError):
    pass


def _read_file(path: str) -> str:
    try:
        return Path(path).read_text().strip()
    except OSError:
        return ""


class VaultClient:
    def __init__(self) -> None:
        self._token: str | None = None
        self._token_expiry: float = 0.0
        self._lock = threading.Lock()
        verify: bool | str = settings.VAULT_CACERT or True
        headers = {"X-Vault-Namespace": settings.VAULT_NAMESPACE} if settings.VAULT_NAMESPACE else {}
        self._http = httpx.Client(base_url=settings.VAULT_ADDR.rstrip("/"), timeout=10, verify=verify, headers=headers)

    # ── Auth ──
    def _login(self) -> None:
        role_id = settings.VAULT_ROLE_ID or _read_file(settings.VAULT_ROLE_ID_FILE)
        secret_id = settings.VAULT_SECRET_ID or _read_file(settings.VAULT_SECRET_ID_FILE)
        if not role_id or not secret_id:
            raise VaultError("Vault AppRole credentials not configured (role_id / secret_id)")
        resp = self._http.post("/v1/auth/approle/login", json={"role_id": role_id, "secret_id": secret_id})
        if resp.status_code != 200:
            raise VaultError(f"Vault AppRole login failed ({resp.status_code}): {resp.text[:200]}")
        auth = resp.json()["auth"]
        self._token = auth["client_token"]
        # Renew a bit before expiry
        self._token_expiry = time.time() + max(60, int(auth.get("lease_duration", 3600)) - 120)

    def _headers(self) -> dict:
        with self._lock:
            if not self._token or time.time() >= self._token_expiry:
                self._login()
            return {"X-Vault-Token": self._token}

    def request(self, method: str, path: str, json: dict | None = None, auth: bool = True) -> dict:
        for attempt in range(2):
            headers = self._headers() if auth else {}
            resp = self._http.request(method, f"/v1/{path}", json=json, headers=headers)
            if resp.status_code == 403 and auth and attempt == 0:
                with self._lock:
                    self._token = None  # token revoked/expired: log in again once
                continue
            if resp.status_code >= 400:
                raise VaultError(f"Vault {method} {path} failed ({resp.status_code}): {resp.text[:300]}")
            return resp.json() if resp.content else {}
        raise VaultError(f"Vault {method} {path}: permission denied")

    # ── Health ──
    def health(self) -> dict:
        resp = self._http.get("/v1/sys/health", params={"standbyok": "true", "sealedcode": "200", "uninitcode": "200"})
        return resp.json()

    # ── Transit ──
    def _transit(self, op: str) -> str:
        return f"{settings.VAULT_TRANSIT_MOUNT}/{op}/{settings.VAULT_TRANSIT_KEY}"

    def encrypt(self, plaintext: bytes) -> str:
        data = self.request("POST", self._transit("encrypt"), {"plaintext": base64.b64encode(plaintext).decode()})
        return data["data"]["ciphertext"]

    def decrypt(self, ciphertext: str) -> bytes:
        data = self.request("POST", self._transit("decrypt"), {"ciphertext": ciphertext})
        return base64.b64decode(data["data"]["plaintext"])

    def rewrap(self, ciphertext: str) -> str:
        data = self.request("POST", self._transit("rewrap"), {"ciphertext": ciphertext})
        return data["data"]["ciphertext"]

    def key_info(self) -> dict:
        return self.request("GET", self._transit("keys"))["data"]

    def rotate_key(self) -> int:
        self.request("POST", f"{self._transit('keys')}/rotate")
        return int(self.key_info()["latest_version"])

    # ── SSH CA ──
    def ssh_public_key(self) -> str:
        resp = self._http.get(f"/v1/{settings.VAULT_SSH_MOUNT}/public_key")
        if resp.status_code != 200:
            raise VaultError(f"Vault SSH CA public key unavailable ({resp.status_code})")
        return resp.text.strip()

    def ssh_sign(self, public_key: str, principals: list[str], ttl_minutes: int, key_id: str) -> str:
        data = self.request("POST", f"{settings.VAULT_SSH_MOUNT}/sign/{settings.VAULT_SSH_ROLE}", {
            "public_key": public_key,
            "valid_principals": ",".join(principals),
            "ttl": f"{ttl_minutes}m",
            "cert_type": "user",
            "key_id": key_id,
            "extensions": {
                "permit-pty": "", "permit-port-forwarding": "",
                "permit-agent-forwarding": "", "permit-X11-forwarding": "",
            },
        })
        return data["data"]["signed_key"].strip()


_client: VaultClient | None = None
_client_lock = threading.Lock()


def get_vault() -> VaultClient:
    global _client
    with _client_lock:
        if _client is None:
            _client = VaultClient()
        return _client


def reset_vault_client() -> None:
    """Testing hook / config reload."""
    global _client
    with _client_lock:
        _client = None
