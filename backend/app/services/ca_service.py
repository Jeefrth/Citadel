"""Mini Certificate Authority for ephemeral SSH certificates.

Two backends (CA_BACKEND):
- local: CA key pair generated on first run and stored in CA_KEY_DIR,
  certificates signed with ssh-keygen.
- vault: the CA key lives in the OpenBao / Vault SSH secrets engine and
  never touches the Citadel host; only the ephemeral user key pair is
  generated locally, its public half is signed by the vault.
"""

import os
import subprocess
import tempfile
import time
import logging
from pathlib import Path

from app.core.config import settings

logger = logging.getLogger("citadel.ca")

# CA key storage directory — persistent, NOT /tmp
_default_ca_dir = Path(__file__).resolve().parents[3] / "data" / "ca"
CA_DIR = Path(os.environ.get("CA_KEY_DIR", str(_default_ca_dir)))
CA_PRIVATE_KEY_PATH = CA_DIR / "ca_key"
CA_PUBLIC_KEY_PATH = CA_DIR / "ca_key.pub"


def _ensure_ca_dir():
    CA_DIR.mkdir(parents=True, exist_ok=True)
    CA_DIR.chmod(0o700)


def _generate_ca_key():
    """Generate a new Ed25519 CA key pair using ssh-keygen."""
    _ensure_ca_dir()
    logger.info("Generating new CA key pair at %s", CA_DIR)

    subprocess.run(
        ["ssh-keygen", "-t", "ed25519", "-f", str(CA_PRIVATE_KEY_PATH), "-N", "", "-q", "-C", "citadel-ca"],
        check=True,
    )
    CA_PRIVATE_KEY_PATH.chmod(0o600)
    CA_PUBLIC_KEY_PATH.chmod(0o644)

    logger.info("CA key pair generated successfully")


def _ensure_ca_exists():
    """Make sure the CA key pair exists, generate if not."""
    if not CA_PRIVATE_KEY_PATH.exists():
        _generate_ca_key()


def _use_vault() -> bool:
    return settings.CA_BACKEND == "vault"


def get_ca_public_key() -> str:
    """Return the CA public key string (for sshd_config TrustedUserCAKeys)."""
    if _use_vault():
        from app.core.vault import get_vault
        return get_vault().ssh_public_key()
    _ensure_ca_exists()
    return CA_PUBLIC_KEY_PATH.read_text().strip()


def sign_user_certificate(
    username: str,
    validity_minutes: int = 480,
    principals: list[str] | None = None,
) -> tuple[str, str]:
    """Generate a new SSH key pair and sign a user certificate with the CA.

    Returns (key_path, cert_path) as temp file paths.
    The caller is responsible for cleaning up the files.

    validity_minutes: certificate lifetime in minutes (default 480 = 8h).
    Supports any value from 1 minute to 1440 minutes (24h).
    """
    if not _use_vault():
        _ensure_ca_exists()

    if principals is None:
        principals = [username]

    # Create temp directory for the ephemeral key pair
    tmpdir = tempfile.mkdtemp(prefix="citadel_cert_")
    key_path = os.path.join(tmpdir, "ephemeral")
    cert_path = key_path + "-cert.pub"

    # Generate ephemeral key
    subprocess.run(
        ["ssh-keygen", "-t", "ed25519", "-f", key_path, "-N", "", "-q"],
        check=True,
    )

    key_id = f"citadel-{username}-{int(time.time())}"

    if _use_vault():
        from app.core.vault import get_vault
        public_key = Path(key_path + ".pub").read_text().strip()
        signed = get_vault().ssh_sign(public_key, principals, validity_minutes, key_id)
        Path(cert_path).write_text(signed + "\n")
        logger.info(
            "Vault-signed ephemeral certificate: user=%s, principals=%s, valid=%dmin, key_id=%s",
            username, principals, validity_minutes, key_id,
        )
        return key_path, cert_path

    # Build validity string for ssh-keygen: +Nm for minutes, +Nh for hours
    if validity_minutes < 60:
        validity_str = f"+{validity_minutes}m"
    else:
        hours = validity_minutes // 60
        remaining_min = validity_minutes % 60
        if remaining_min == 0:
            validity_str = f"+{hours}h"
        else:
            validity_str = f"+{hours}h{remaining_min}m"

    # Sign with CA
    subprocess.run(
        [
            "ssh-keygen", "-s", str(CA_PRIVATE_KEY_PATH),
            "-I", key_id,
            "-n", ",".join(principals),
            "-V", validity_str,
            key_path + ".pub",
        ],
        check=True,
    )

    logger.info(
        "Signed ephemeral certificate: user=%s, principals=%s, valid=%dmin, key_id=%s",
        username, principals, validity_minutes, key_id,
    )

    return key_path, cert_path


def cleanup_cert_files(key_path: str):
    """Remove temporary certificate files."""
    tmpdir = os.path.dirname(key_path)
    for f in os.listdir(tmpdir):
        os.unlink(os.path.join(tmpdir, f))
    os.rmdir(tmpdir)


def get_setup_instructions(server_hostname: str) -> str:
    """Return shell commands to configure a server to trust this CA."""
    pub_key = get_ca_public_key()
    return f"""# Setup ephemeral SSH certificates on {server_hostname}
# Run these commands as root on the target server:

# 1. Add the CA public key
echo '{pub_key}' | sudo tee /etc/ssh/citadel_ca.pub

# 2. Configure sshd to trust it
echo 'TrustedUserCAKeys /etc/ssh/citadel_ca.pub' | sudo tee -a /etc/ssh/sshd_config

# 3. Restart sshd
sudo systemctl restart sshd

# Done! citadel can now authenticate via ephemeral certificates."""
