from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Database
    DATABASE_URL: str = "postgresql+asyncpg://srv_gest:changeme@db:5432/srv_gest"

    # Redis
    REDIS_URL: str = "redis://redis:6379/0"

    # Microsoft Entra ID
    AZURE_TENANT_ID: str = ""
    AZURE_CLIENT_ID: str = ""

    # Security
    CREDENTIAL_ENCRYPTION_KEY: str = ""
    SECRET_KEY: str = "dev-secret-key-change-in-production"

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
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.BACKEND_CORS_ORIGINS.split(",")]

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()
