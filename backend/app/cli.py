"""Citadel maintenance CLI.

    python -m app.cli vault-bootstrap      # idempotent OpenBao/Vault setup (compose job)
    python -m app.cli secrets-status
    python -m app.cli secrets-migrate      # local AES blobs -> vault transit
    python -m app.cli secrets-rotate-key   # new transit key version + rewrap all
"""

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

import httpx

TRANSIT_MOUNT = os.environ.get("VAULT_TRANSIT_MOUNT", "transit")
TRANSIT_KEY = os.environ.get("VAULT_TRANSIT_KEY", "citadel-credentials")
SSH_MOUNT = os.environ.get("VAULT_SSH_MOUNT", "ssh-client-signer")
SSH_ROLE = os.environ.get("VAULT_SSH_ROLE", "citadel")
POLICY_NAME = "citadel"
APPROLE_NAME = "citadel"

POLICY_HCL = f"""
# Citadel backend: least privilege
path "{TRANSIT_MOUNT}/encrypt/{TRANSIT_KEY}" {{ capabilities = ["update"] }}
path "{TRANSIT_MOUNT}/decrypt/{TRANSIT_KEY}" {{ capabilities = ["update"] }}
path "{TRANSIT_MOUNT}/rewrap/{TRANSIT_KEY}"  {{ capabilities = ["update"] }}
path "{TRANSIT_MOUNT}/keys/{TRANSIT_KEY}"    {{ capabilities = ["read"] }}
path "{TRANSIT_MOUNT}/keys/{TRANSIT_KEY}/rotate" {{ capabilities = ["update"] }}
# one key per organisation (SaaS): create, use, rotate; never delete or export
path "{TRANSIT_MOUNT}/encrypt/citadel-org-*" {{ capabilities = ["update"] }}
path "{TRANSIT_MOUNT}/decrypt/citadel-org-*" {{ capabilities = ["update"] }}
path "{TRANSIT_MOUNT}/rewrap/citadel-org-*"  {{ capabilities = ["update"] }}
path "{TRANSIT_MOUNT}/keys/citadel-org-*"    {{ capabilities = ["create", "read", "update"] }}
path "{TRANSIT_MOUNT}/keys/citadel-org-*/rotate" {{ capabilities = ["update"] }}
path "{SSH_MOUNT}/sign/{SSH_ROLE}"           {{ capabilities = ["update"] }}
path "{SSH_MOUNT}/public_key"                {{ capabilities = ["read"] }}
"""


def log(msg: str) -> None:
    print(f"[vault-bootstrap] {msg}", flush=True)


class Bootstrap:
    def __init__(self, addr: str, init_dir: Path, approle_dir: Path, ca_dir: Path, rotate_secret_id: bool):
        self.http = httpx.Client(base_url=addr.rstrip("/"), timeout=15)
        self.init_file = init_dir / "init.json"
        self.approle_dir = approle_dir
        self.ca_dir = ca_dir
        self.rotate_secret_id = rotate_secret_id
        self.token: str | None = None

    # ── helpers ──
    def call(self, method: str, path: str, body: dict | None = None, ok=(200, 204)) -> httpx.Response:
        headers = {"X-Vault-Token": self.token} if self.token else {}
        resp = self.http.request(method, f"/v1/{path}", json=body, headers=headers)
        if resp.status_code not in ok:
            raise RuntimeError(f"{method} {path} -> {resp.status_code}: {resp.text[:300]}")
        return resp

    def wait_for_vault(self, timeout: int = 120) -> dict:
        deadline = time.time() + timeout
        while True:
            try:
                r = self.http.get("/v1/sys/health", params={"uninitcode": "200", "sealedcode": "200", "standbyok": "true"})
                return r.json()
            except httpx.HTTPError as e:
                if time.time() > deadline:
                    raise RuntimeError(f"Vault not reachable: {e}")
                time.sleep(2)

    # ── steps ──
    def init_and_unseal(self) -> None:
        health = self.wait_for_vault()
        if not health.get("initialized"):
            log("initializing (1 key share, threshold 1)")
            resp = self.call("POST", "sys/init", {"secret_shares": 1, "secret_threshold": 1}).json()
            self.init_file.parent.mkdir(parents=True, exist_ok=True)
            self.init_file.write_text(json.dumps({"unseal_keys_b64": resp["keys_base64"], "root_token": resp["root_token"]}))
            self.init_file.chmod(0o600)
            log(f"init material written to {self.init_file} (keep it safe, see docs/vault.md)")
        if not self.init_file.exists():
            raise RuntimeError(f"Vault is initialized but {self.init_file} is missing: cannot unseal/configure")
        material = json.loads(self.init_file.read_text())
        self.token = material["root_token"]
        if self.wait_for_vault().get("sealed"):
            log("unsealing")
            for key in material["unseal_keys_b64"]:
                self.call("POST", "sys/unseal", {"key": key})
        if self.wait_for_vault().get("sealed"):
            raise RuntimeError("Vault is still sealed")

    def mounts(self) -> dict:
        return self.call("GET", "sys/mounts").json().get("data") or self.call("GET", "sys/mounts").json()

    def enable_engine(self, path: str, engine_type: str) -> None:
        if f"{path}/" not in self.mounts():
            log(f"enabling {engine_type} at {path}/")
            self.call("POST", f"sys/mounts/{path}", {"type": engine_type})

    def setup_transit(self) -> None:
        self.enable_engine(TRANSIT_MOUNT, "transit")
        r = self.call("GET", f"{TRANSIT_MOUNT}/keys/{TRANSIT_KEY}", ok=(200, 404))
        if r.status_code == 404:
            log(f"creating transit key {TRANSIT_KEY} (aes256-gcm96)")
            self.call("POST", f"{TRANSIT_MOUNT}/keys/{TRANSIT_KEY}", {"type": "aes256-gcm96"})
        # Never exportable, never deletable by accident
        self.call("POST", f"{TRANSIT_MOUNT}/keys/{TRANSIT_KEY}/config",
                  {"deletion_allowed": False, "exportable": False, "allow_plaintext_backup": False})

    def setup_ssh_ca(self) -> None:
        self.enable_engine(SSH_MOUNT, "ssh")
        r = self.call("GET", f"{SSH_MOUNT}/config/ca", ok=(200, 400, 404))
        configured = r.status_code == 200 and (r.json().get("data") or {}).get("public_key")
        if not configured:
            priv, pub = self.ca_dir / "ca_key", self.ca_dir / "ca_key.pub"
            if priv.exists() and pub.exists():
                log("importing the existing local Citadel CA key (servers keep trusting it)")
                self.call("POST", f"{SSH_MOUNT}/config/ca",
                          {"private_key": priv.read_text(), "public_key": pub.read_text().strip()})
            else:
                log("generating a new SSH CA (ed25519) inside the vault")
                self.call("POST", f"{SSH_MOUNT}/config/ca", {"generate_signing_key": True, "key_type": "ed25519"})
        self.call("POST", f"{SSH_MOUNT}/roles/{SSH_ROLE}", {
            "key_type": "ca",
            "allow_user_certificates": True,
            "allowed_users": "*",
            "allow_user_key_ids": True,
            "default_extensions": {"permit-pty": ""},
            "allowed_extensions": "permit-pty,permit-port-forwarding,permit-agent-forwarding,permit-X11-forwarding",
            "ttl": "8h",
            "max_ttl": "24h",
        })

    def setup_approle(self) -> None:
        self.call("PUT", f"sys/policies/acl/{POLICY_NAME}", {"policy": POLICY_HCL})
        auths = self.call("GET", "sys/auth").json()
        auths = auths.get("data") or auths
        if "approle/" not in auths:
            log("enabling approle auth")
            self.call("POST", "sys/auth/approle", {"type": "approle"})
        self.call("POST", f"auth/approle/role/{APPROLE_NAME}", {
            "token_policies": [POLICY_NAME],
            "token_ttl": "1h",
            "token_max_ttl": "4h",
            "secret_id_ttl": "0",
            "token_no_default_policy": False,
        })
        self.approle_dir.mkdir(parents=True, exist_ok=True)
        role_id = self.call("GET", f"auth/approle/role/{APPROLE_NAME}/role-id").json()["data"]["role_id"]
        (self.approle_dir / "role_id").write_text(role_id)
        secret_file = self.approle_dir / "secret_id"
        if self.rotate_secret_id or not secret_file.exists():
            if secret_file.exists():
                # Destroy the old secret_id so only the new one remains valid
                old = secret_file.read_text().strip()
                self.call("POST", f"auth/approle/role/{APPROLE_NAME}/secret-id/destroy", {"secret_id": old}, ok=(200, 204, 400))
            log("issuing a new AppRole secret_id")
            secret_id = self.call("POST", f"auth/approle/role/{APPROLE_NAME}/secret-id").json()["data"]["secret_id"]
            secret_file.write_text(secret_id)
        for f in (self.approle_dir / "role_id", secret_file):
            f.chmod(0o644)  # read by the backend container user (mounted read-only)

    def run(self) -> None:
        self.init_and_unseal()
        self.setup_transit()
        self.setup_ssh_ca()
        self.setup_approle()
        log("done")


def cmd_bootstrap(args) -> None:
    Bootstrap(
        addr=os.environ.get("VAULT_ADDR", "http://openbao:8200"),
        init_dir=Path(os.environ.get("VAULT_INIT_DIR", "/bootstrap/init")),
        approle_dir=Path(os.environ.get("VAULT_APPROLE_DIR", "/bootstrap/approle")),
        ca_dir=Path(os.environ.get("CA_KEY_DIR", "/data/ca")),
        rotate_secret_id=args.rotate_secret_id,
    ).run()


def _run_async(coro):
    return asyncio.run(coro)


def cmd_init_volumes(_args) -> None:
    """Prepare shared directories (recordings) for guacd (uid 1000) and the backend."""
    root = Path(os.environ.get("RECORDING_DIR", "/recordings"))
    for sub in ("raw", "store"):
        d = root / sub
        d.mkdir(parents=True, exist_ok=True)
        try:
            os.chown(d, 1000, 1000)
            d.chmod(0o770)
        except PermissionError:
            pass  # bind mounts on Docker Desktop: permissions are managed by the host
    print(f"[init-volumes] {root} ready", flush=True)


def cmd_status(_args) -> None:
    from app.services import secrets_admin
    print(json.dumps(_run_async(secrets_admin.status_standalone()), indent=2, default=str))


def cmd_migrate(_args) -> None:
    from app.services import secrets_admin
    print(json.dumps(_run_async(secrets_admin.migrate_standalone()), indent=2))


def cmd_rotate_key(_args) -> None:
    from app.services import secrets_admin
    print(json.dumps(_run_async(secrets_admin.rotate_key_standalone()), indent=2))


def cmd_backup_decrypt(args) -> None:
    """Works without a database or a vault: only the file and the passphrase."""
    import getpass
    from app.services.account_backup import decrypt_archive
    with open(args.file, "rb") as f:
        blob = f.read()
    passphrase = getpass.getpass("Phrase de passe des sauvegardes : ")
    data = decrypt_archive(blob, passphrase)
    out = json.dumps(data, indent=2, ensure_ascii=False)
    if args.output:
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(out)
        print(f"{len(data.get('accounts', []))} compte(s) écrits dans {args.output} (mode 600)", file=sys.stderr)
    else:
        print(out)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("vault-bootstrap", help="Initialize/unseal/configure OpenBao for Citadel (idempotent)")
    b.add_argument("--rotate-secret-id", action="store_true", help="Issue a new AppRole secret_id and destroy the old one")
    b.set_defaults(func=cmd_bootstrap)
    sub.add_parser("init-volumes", help="Create shared recording directories").set_defaults(func=cmd_init_volumes)
    sub.add_parser("secrets-status").set_defaults(func=cmd_status)
    sub.add_parser("secrets-migrate", help="Re-encrypt local AES blobs with the vault").set_defaults(func=cmd_migrate)
    sub.add_parser("secrets-rotate-key", help="Rotate the transit key and rewrap every blob").set_defaults(func=cmd_rotate_key)
    d = sub.add_parser("backup-decrypt", help="Decrypt an account backup (.cab) with its passphrase")
    d.add_argument("file")
    d.add_argument("-o", "--output", help="write JSON here (mode 600) instead of stdout")
    d.set_defaults(func=cmd_backup_decrypt)
    args = parser.parse_args(argv)
    try:
        args.func(args)
    except Exception as e:  # noqa: BLE001 - CLI boundary
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
