"""Recording storage (D8): local disk, S3-compatible (AWS, MinIO...) or Azure Blob.

Objects are gzip-compressed; the SHA-256 of the stored bytes is kept in the
database so any later tampering with a recording is detectable on read.
Secrets (S3 secret key, Azure SAS token) are encrypted like credentials.
"""

import asyncio
import gzip
import hashlib
import io
import logging
from dataclasses import dataclass
from pathlib import Path

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import decrypt_value
from app.models.audit_trail import RecordingStorage

logger = logging.getLogger("citadel.storage")


class StorageError(RuntimeError):
    pass


class IntegrityError(StorageError):
    pass


@dataclass
class StoredObject:
    storage_type: str
    key: str
    sha256: str
    size: int


class LocalBackend:
    type = "local"

    def __init__(self, root: str | None = None):
        self.root = Path(root or settings.RECORDING_DIR) / "store"

    def _path(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if not str(p).startswith(str(self.root.resolve()) + "/"):
            raise StorageError("Invalid storage key")
        return p

    async def put(self, key: str, data: bytes) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(p)

    async def get(self, key: str) -> bytes:
        try:
            return self._path(key).read_bytes()
        except FileNotFoundError:
            raise StorageError(f"Object not found: {key}")

    async def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)


class S3Backend:
    type = "s3"

    def __init__(self, config: dict, secret: str | None):
        from minio import Minio
        endpoint = config.get("endpoint") or "s3.amazonaws.com"
        self.bucket = config["bucket"]
        self.prefix = (config.get("prefix") or "").strip("/")
        self.client = Minio(endpoint, access_key=config.get("access_key"), secret_key=secret,
                            secure=config.get("secure", True), region=config.get("region") or None)

    def _k(self, key: str) -> str:
        return f"{self.prefix}/{key}" if self.prefix else key

    async def put(self, key: str, data: bytes) -> None:
        await asyncio.to_thread(self.client.put_object, self.bucket, self._k(key), io.BytesIO(data), len(data),
                                content_type="application/gzip")

    async def get(self, key: str) -> bytes:
        def _get():
            resp = self.client.get_object(self.bucket, self._k(key))
            try:
                return resp.read()
            finally:
                resp.close()
                resp.release_conn()
        try:
            return await asyncio.to_thread(_get)
        except Exception as e:  # noqa: BLE001
            raise StorageError(f"S3 read failed: {e}")

    async def delete(self, key: str) -> None:
        await asyncio.to_thread(self.client.remove_object, self.bucket, self._k(key))


class AzureBlobBackend:
    """Azure Blob via a container SAS token (no SDK): container_url + '?' + sas."""
    type = "azure"

    def __init__(self, config: dict, secret: str | None):
        self.container_url = config["container_url"].rstrip("/")
        self.prefix = (config.get("prefix") or "").strip("/")
        self.sas = (secret or "").lstrip("?")
        if not self.sas:
            raise StorageError("Azure SAS token missing")

    def _url(self, key: str) -> str:
        k = f"{self.prefix}/{key}" if self.prefix else key
        return f"{self.container_url}/{k}?{self.sas}"

    async def put(self, key: str, data: bytes) -> None:
        async with httpx.AsyncClient(timeout=120) as c:
            r = await c.put(self._url(key), content=data, headers={
                "x-ms-blob-type": "BlockBlob", "Content-Type": "application/gzip"})
            if r.status_code >= 300:
                raise StorageError(f"Azure put failed ({r.status_code}): {r.text[:200]}")

    async def get(self, key: str) -> bytes:
        async with httpx.AsyncClient(timeout=120) as c:
            r = await c.get(self._url(key))
            if r.status_code >= 300:
                raise StorageError(f"Azure get failed ({r.status_code})")
            return r.content

    async def delete(self, key: str) -> None:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.delete(self._url(key))
            if r.status_code not in (202, 404):
                raise StorageError(f"Azure delete failed ({r.status_code})")


def backend_from(row: RecordingStorage | None):
    if row is None or row.type == "local":
        return LocalBackend()
    secret = decrypt_value(row.encrypted_secret) if row.encrypted_secret else None
    if row.type == "s3":
        return S3Backend(row.config or {}, secret)
    if row.type == "azure":
        return AzureBlobBackend(row.config or {}, secret)
    raise StorageError(f"Unknown storage type {row.type}")


async def active_backend(db: AsyncSession):
    row = (await db.execute(
        select(RecordingStorage).where(RecordingStorage.is_active.is_(True)).limit(1)
    )).scalar_one_or_none()
    return backend_from(row)


async def backend_for(db: AsyncSession, storage_type: str | None):
    """Backend able to read an object written with `storage_type` (may differ from the active one)."""
    if not storage_type or storage_type == "local":
        return LocalBackend()
    row = (await db.execute(
        select(RecordingStorage).where(RecordingStorage.type == storage_type)
        .order_by(RecordingStorage.is_active.desc(), RecordingStorage.created_at.desc()).limit(1)
    )).scalar_one_or_none()
    if row is None:
        raise StorageError(f"No configuration left for storage type '{storage_type}'")
    return backend_from(row)


async def store(db: AsyncSession, key: str, raw: bytes) -> StoredObject:
    data = gzip.compress(raw, compresslevel=6)
    backend = await active_backend(db)
    try:
        await backend.put(key, data)
    except Exception as e:  # noqa: BLE001 - never lose a recording: fall back to local disk
        logger.error("storage %s failed (%s), keeping recording on local disk", backend.type, e)
        backend = LocalBackend()
        await backend.put(key, data)
    return StoredObject(backend.type, key, hashlib.sha256(data).hexdigest(), len(data))


async def load(db: AsyncSession, storage_type: str | None, key: str, sha256: str | None) -> bytes:
    data = await (await backend_for(db, storage_type)).get(key)
    if sha256 and hashlib.sha256(data).hexdigest() != sha256:
        raise IntegrityError("Recording integrity check failed (SHA-256 mismatch)")
    return gzip.decompress(data)


async def remove(db: AsyncSession, storage_type: str | None, key: str) -> None:
    try:
        await (await backend_for(db, storage_type)).delete(key)
    except Exception as e:  # noqa: BLE001
        logger.warning("could not delete %s/%s: %s", storage_type, key, e)
