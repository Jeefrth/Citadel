"""Mini Certificate Authority for ephemeral SSH certificates.

Generates a CA key pair on first run (stored on disk), then signs
short-lived SSH user certificates on demand using ssh-keygen.
Existing credential types (password, ssh_key, winrm) are NOT affected.
"""

import os
import subprocess
import tempfile
import time
import logging
from pathlib import Path

from app.core.config import settings

logger = logging.getLogger("srv_gest.ca")

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
        ["ssh-keygen", "-t", "ed25519", "-f", str(CA_PRIVATE_KEY_PATH), "-N", "", "-q", "-C", "srv_gest-ca"],
        check=True,
    )
    CA_PRIVATE_KEY_PATH.chmod(0o600)
    CA_PUBLIC_KEY_PATH.chmod(0o644)

    logger.info("CA key pair generated successfully")


def _ensure_ca_exists():
    """Make sure the CA key pair exists, generate if not."""
    if not CA_PRIVATE_KEY_PATH.exists():
        _generate_ca_key()


def get_ca_public_key() -> str:
    """Return the CA public key string (for sshd_config TrustedUserCAKeys)."""
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
    _ensure_ca_exists()

    if principals is None:
        principals = [username]

    # Create temp directory for the ephemeral key pair
    tmpdir = tempfile.mkdtemp(prefix="srv_gest_cert_")
    key_path = os.path.join(tmpdir, "ephemeral")
    cert_path = key_path + "-cert.pub"

    # Generate ephemeral key
    subprocess.run(
        ["ssh-keygen", "-t", "ed25519", "-f", key_path, "-N", "", "-q"],
        check=True,
    )

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
    key_id = f"srv_gest-{username}-{int(time.time())}"
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
        "Signed ephemeral certificate: user=%s, principals=%s, valid=%dh, key_id=%s",
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
echo '{pub_key}' | sudo tee /etc/ssh/srv_gest_ca.pub

# 2. Configure sshd to trust it
echo 'TrustedUserCAKeys /etc/ssh/srv_gest_ca.pub' | sudo tee -a /etc/ssh/sshd_config

# 3. Restart sshd
sudo systemctl restart sshd

# Done! srv_gest can now authenticate via ephemeral certificates."""
