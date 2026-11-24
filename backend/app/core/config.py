from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Database
    DATABASE_URL: str = "postgresql+asyncpg://citadel:changeme@db:5432/citadel"

    # Redis
    REDIS_URL: str = "redis://redis:6379/0"

    # Microsoft Entra ID
    AZURE_TENANT_ID: str = ""
    AZURE_CLIENT_ID: str = ""

    # Security
    CREDENTIAL_ENCRYPTION_KEY: str = ""
    SECRET_KEY: str = "dev-secret-key-change-in-production"

    # Secrets backend: "local" (AES-256-GCM with CREDENTIAL_ENCRYPTION_KEY)
    # or "vault" (OpenBao / HashiCorp Vault Transit engine, key never leaves the vault)
    SECRETS_BACKEND: str = "local"
    # SSH CA backend: "local" (key file in CA_KEY_DIR) or "vault" (SSH secrets engine)
    CA_BACKEND: str = "local"

    # OpenBao / Vault (API compatible)
    VAULT_ADDR: str = "http://openbao:8200"
    VAULT_NAMESPACE: str = ""
    VAULT_CACERT: str = ""
    VAULT_ROLE_ID: str = ""
    VAULT_SECRET_ID: str = ""
    # Files written by the bootstrap job (take precedence over empty values above)
    VAULT_ROLE_ID_FILE: str = "/bootstrap/approle/role_id"
    VAULT_SECRET_ID_FILE: str = "/bootstrap/approle/secret_id"
    VAULT_TRANSIT_MOUNT: str = "transit"
    VAULT_TRANSIT_KEY: str = "citadel-credentials"
    VAULT_SSH_MOUNT: str = "ssh-client-signer"
    VAULT_SSH_ROLE: str = "citadel"

    # Background jobs (rotation, verification, discovery)
    SCHEDULER_ENABLED: bool = True
    SCHEDULER_INTERVAL_SECONDS: int = 300
    ACCOUNT_VERIFY_INTERVAL_HOURS: int = 24
    ACCOUNT_DISCOVERY_INTERVAL_HOURS: int = 24

    # Dev mode (bypass auth)
    DEV_MODE: bool = False

    # CORS
    BACKEND_CORS_ORIGINS: str = "http://localhost:5173"

    @property
    def azure_authority(self) -> str:
        return f"https://login.microsoftonline.com/{self.AZURE_TENANT_ID}"

    @property
    def azure_jwks_url(self) -> str:
        return f"https://login.microsoftonline.com/{self.AZURE_TENANT_ID}/discovery/v2.0/keys"

    @property
    def azure_issuer(self) -> str:
        return f"https://login.microsoftonline.com/{self.AZURE_TENANT_ID}/v2.0"

    @property
    def azure_issuers(self) -> list[str]:
        """Accepted issuers: v2 and v1 token formats of OUR tenant only."""
        return [self.azure_issuer, f"https://sts.windows.net/{self.AZURE_TENANT_ID}/"]

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.BACKEND_CORS_ORIGINS.split(",")]

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()
