"""Web file transfers over SFTP (E1), Linux servers.

Each call opens its own SSH connection (through the zone's gateway when
needed) with the account the user picked, so file operations run with that
account's OS permissions and nothing more.
"""

import hashlib
import posixpath
import stat
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import AsyncIterator

import asyncssh

from app.core.permissions import ResolvedAccount
from app.models.server import Server
from app.services import routing, ssh_service

CHUNK = 256 * 1024


class SftpError(RuntimeError):
    pass


@dataclass
class Entry:
    name: str
    path: str
    type: str          # file | dir | link | other
    size: int
    mode: str          # "drwxr-xr-x"
    mtime: int | None
    owner: str | None
    group: str | None


@asynccontextmanager
async def open_sftp(server: Server, account: ResolvedAccount) -> AsyncIterator[asyncssh.SFTPClient]:
    async with routing.via(server):
        kwargs = ({"use_ephemeral_cert": True, "cert_validity_minutes": 5} if account.use_cert
                  else {"password": account.password, "ssh_key": account.ssh_key})
        conn = await ssh_service._connect(server.ip_address, server.ssh_port, account.username, **kwargs)
        try:
            async with conn.start_sftp_client() as client:
                yield client
        finally:
            conn.close()


def clean_path(path: str | None) -> str:
    """Normalise a client-supplied absolute path ('' or None = home, resolved later)."""
    if not path:
        return ""
    if "\x00" in path:
        raise SftpError("Invalid path")
    # leading "//" is kept by normpath (POSIX allows it): always one root slash
    return posixpath.normpath("/" + path.lstrip("/"))


def _entry(dirpath: str, name: str, attrs: asyncssh.SFTPAttrs, longname: str | None) -> Entry:
    perms = attrs.permissions or 0
    if stat.S_ISDIR(perms):
        kind = "dir"
    elif stat.S_ISLNK(perms):
        kind = "link"
    elif stat.S_ISREG(perms):
        kind = "file"
    else:
        kind = "other"
    owner = group = None
    if longname:  # "drwxr-xr-x  2 alice users 4096 Nov 24 19:03 name"
        parts = longname.split(None, 8)
        if len(parts) >= 4:
            owner, group = parts[2], parts[3]
    return Entry(
        name=name, path=posixpath.join(dirpath, name), type=kind, size=attrs.size or 0,
        mode=stat.filemode(perms) if perms else "", mtime=attrs.mtime, owner=owner, group=group,
    )


async def list_dir(client: asyncssh.SFTPClient, path: str) -> tuple[str, list[Entry]]:
    real = await client.realpath(path or ".")
    items = []
    for n in await client.readdir(real):
        if n.filename in (".", ".."):
            continue
        items.append(_entry(real, n.filename, n.attrs, n.longname))
    items.sort(key=lambda e: (e.type != "dir", e.name.lower()))
    return real, items


async def stat_file(client: asyncssh.SFTPClient, path: str) -> asyncssh.SFTPAttrs:
    try:
        return await client.stat(path)
    except asyncssh.SFTPNoSuchFile:
        raise SftpError("No such file")


async def write_stream(client: asyncssh.SFTPClient, path: str, chunks: AsyncIterator[bytes],
                       max_bytes: int, overwrite: bool) -> tuple[int, str]:
    """Write an upload; returns (size, sha256). Partial files are removed on failure."""
    if not overwrite:
        try:
            await client.stat(path)
            raise SftpError("A file with this name already exists")
        except asyncssh.SFTPNoSuchFile:
            pass
    digest, size = hashlib.sha256(), 0
    try:
        async with client.open(path, "wb") as f:
            async for chunk in chunks:
                size += len(chunk)
                if size > max_bytes:
                    raise SftpError(f"File larger than the {max_bytes // (1024 * 1024)} MB limit")
                digest.update(chunk)
                await f.write(chunk)
    except Exception:
        try:
            await client.remove(path)
        except Exception:  # noqa: BLE001
            pass
        raise
    return size, digest.hexdigest()


async def remove(client: asyncssh.SFTPClient, path: str) -> str:
    attrs = await stat_file(client, path)
    if stat.S_ISDIR(attrs.permissions or 0):
        try:
            await client.rmdir(path)  # empty directories only, on purpose
        except asyncssh.SFTPFailure:
            raise SftpError("Directory is not empty: only empty directories can be deleted")
        return "dir"
    await client.remove(path)
    return "file"
