"""Cloud inventory sync (A8): Azure virtual machines -> Citadel servers.

Azure Resource Manager REST API with a service principal (client credentials).
Read-only role needed on the subscriptions: "Reader" is enough.

- New VMs are created as servers (no account: an admin adds one), under the
  account's node, in a sub-node per resource group, in the account's zone.
- Known VMs (cloud_ref) get their IP / OS refreshed and new Azure tags added;
  names and existing tag values are kept (tags drive access policies and ACLs,
  so whoever edits tags in Azure must not be able to change them in Citadel).
  Only the sync's own keys (cloud, azure_rg, azure_location, azure_power) follow
  Azure.
- VMs gone from Azure are flagged cloud_state = "missing", never deleted.
"""

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import decrypt_value
from app.models.audit import AuditLog
from app.models.base import OSType
from app.models.operations import CloudAccount, CloudPendingVM
from app.models.pam import Node
from app.models.server import Server

logger = logging.getLogger("citadel.cloud")
ARM = "https://management.azure.com"
LOGIN = "https://login.microsoftonline.com"
API_COMPUTE = "2024-07-01"
API_NETWORK = "2024-05-01"


@dataclass
class AzureVm:
    id: str
    name: str
    computer_name: str | None
    resource_group: str
    location: str
    os_type: str            # Linux | Windows
    private_ip: str | None
    public_ip: str | None
    power_state: str | None  # running | deallocated | stopped | ...
    tags: dict



def merge_tags(existing: dict | None, azure: dict, managed: dict) -> dict:
    """Existing Citadel values win over Azure tags (new Azure keys are added);
    the sync's own keys always follow Azure."""
    return {**azure, **(existing or {}), **managed}

async def _token(client: httpx.AsyncClient, cfg: dict, secret: str) -> str:
    r = await client.post(f"{LOGIN}/{cfg['tenant_id']}/oauth2/v2.0/token", data={
        "grant_type": "client_credentials", "client_id": cfg["client_id"], "client_secret": secret,
        "scope": f"{ARM}/.default",
    })
    if r.status_code != 200:
        raise RuntimeError(f"Azure authentication failed ({r.status_code}): {r.text[:300]}")
    return r.json()["access_token"]


async def _list(client: httpx.AsyncClient, token: str, url: str) -> list[dict]:
    items, next_url = [], url
    while next_url:
        r = await client.get(next_url, headers={"Authorization": f"Bearer {token}"})
        if r.status_code != 200:
            raise RuntimeError(f"Azure API {r.status_code} on {url.split('?')[0]}: {r.text[:300]}")
        body = r.json()
        items.extend(body.get("value", []))
        next_url = body.get("nextLink")
    return items


def _rg(resource_id: str) -> str:
    parts = resource_id.split("/")
    try:
        return parts[parts.index("resourceGroups") + 1]
    except (ValueError, IndexError):
        return ""


async def fetch_vms(client: httpx.AsyncClient, cfg: dict, secret: str) -> list[AzureVm]:
    token = await _token(client, cfg, secret)
    vms: list[AzureVm] = []
    for sub in cfg.get("subscription_ids") or []:
        base = f"{ARM}/subscriptions/{sub}/providers"
        raw = await _list(client, token, f"{base}/Microsoft.Compute/virtualMachines?api-version={API_COMPUTE}")
        status = await _list(client, token, f"{base}/Microsoft.Compute/virtualMachines?api-version={API_COMPUTE}&statusOnly=true")
        nics = await _list(client, token, f"{base}/Microsoft.Network/networkInterfaces?api-version={API_NETWORK}")
        pips = await _list(client, token, f"{base}/Microsoft.Network/publicIPAddresses?api-version={API_NETWORK}")

        power = {}
        for s in status:
            for st in (s.get("properties", {}).get("instanceView", {}) or {}).get("statuses", []):
                if st.get("code", "").startswith("PowerState/"):
                    power[s["id"].lower()] = st["code"].split("/", 1)[1]
        pip_by_id = {p["id"].lower(): (p.get("properties") or {}).get("ipAddress") for p in pips}
        nic_ips = {}
        for n in nics:
            priv = pub = None
            for cfg_ip in (n.get("properties") or {}).get("ipConfigurations", []):
                props = cfg_ip.get("properties") or {}
                if priv is None or props.get("primary"):
                    priv = props.get("privateIPAddress") or priv
                    pid = ((props.get("publicIPAddress") or {}).get("id") or "").lower()
                    pub = pip_by_id.get(pid) or pub
            nic_ips[n["id"].lower()] = (priv, pub)

        for v in raw:
            props = v.get("properties") or {}
            nic_refs = (props.get("networkProfile") or {}).get("networkInterfaces", [])
            primary = next((x for x in nic_refs if (x.get("properties") or {}).get("primary")), nic_refs[0] if nic_refs else None)
            priv, pub = nic_ips.get((primary or {}).get("id", "").lower(), (None, None))
            vms.append(AzureVm(
                id=v["id"], name=v["name"],
                computer_name=(props.get("osProfile") or {}).get("computerName"),
                resource_group=_rg(v["id"]), location=v.get("location", ""),
                os_type=((props.get("storageProfile") or {}).get("osDisk") or {}).get("osType", "Linux"),
                private_ip=priv, public_ip=pub, power_state=power.get(v["id"].lower()),
                tags={k: str(val) for k, val in (v.get("tags") or {}).items()},
            ))
    return vms


async def _child_node(db: AsyncSession, parent_id, name: str):
    if parent_id is None:
        return None
    node = (await db.execute(select(Node).where(Node.parent_id == parent_id, Node.name == name))).scalar_one_or_none()
    if node is None:
        node = Node(name=name, parent_id=parent_id, description="Groupe de ressources Azure (synchronisé)")
        db.add(node)
        await db.flush()
    return node.id


async def create_server(db: AsyncSession, account: CloudAccount, *, ref: str, name: str, computer_name: str | None,
                        ip: str, os_type: OSType, tags: dict, resource_group: str | None) -> Server:
    server = Server(
        name=name, hostname=computer_name or name, ip_address=ip, os_type=os_type,
        tags=tags, cloud_ref=ref, cloud_state="present",
        node_id=await _child_node(db, account.node_id, resource_group) if resource_group else account.node_id,
        zone_id=account.zone_id,
    )
    db.add(server)
    return server


async def _queue_for_review(db: AsyncSession, account: CloudAccount, ref: str, vm: "AzureVm", ip: str,
                            os_type: OSType, tags: dict) -> bool:
    """New VM with review on: one pending row per VM (an ignored VM stays ignored). True if new."""
    row = (await db.execute(select(CloudPendingVM).where(CloudPendingVM.cloud_ref == ref))).scalar_one_or_none()
    is_new = row is None
    if row is None:
        row = CloudPendingVM(cloud_account_id=account.id, cloud_ref=ref, name=vm.name)
        db.add(row)
    row.name, row.computer_name, row.ip_address = vm.name, vm.computer_name, ip
    row.os_type = os_type.value
    row.resource_group, row.location, row.power_state = vm.resource_group, vm.location, vm.power_state
    row.tags = tags
    row.last_seen = datetime.now(timezone.utc)
    return is_new


async def import_pending(db: AsyncSession, row: CloudPendingVM, account: CloudAccount) -> Server:
    if (await db.execute(select(Server).where(Server.cloud_ref == row.cloud_ref))).scalar_one_or_none():
        raise ValueError("Cette VM est déjà importée")
    server = await create_server(db, account, ref=row.cloud_ref, name=row.name, computer_name=row.computer_name,
                                 ip=row.ip_address, os_type=OSType(row.os_type), tags=row.tags or {},
                                 resource_group=row.resource_group)
    await db.delete(row)
    return server


async def sync_account(db: AsyncSession, account: CloudAccount, actor_id=None,
                       client: httpx.AsyncClient | None = None) -> dict:
    cfg = account.config or {}
    secret = decrypt_value(account.encrypted_secret) if account.encrypted_secret else ""
    stats = {"created": 0, "updated": 0, "missing": 0, "skipped": 0, "pending": 0, "new_pending": 0}
    own_client = client is None
    client = client or httpx.AsyncClient(timeout=30)
    try:
        vms = await fetch_vms(client, cfg, secret)
        seen = set()
        for vm in vms:
            ref = f"azure:{vm.id.lower()}"
            seen.add(ref)
            ip = (vm.public_ip if cfg.get("use_public_ip") else vm.private_ip) or vm.private_ip or vm.public_ip
            os_type = OSType.WINDOWS if vm.os_type.lower() == "windows" else OSType.LINUX
            cloud_tags = {"cloud": "azure", "azure_rg": vm.resource_group, "azure_location": vm.location,
                          **({"azure_power": vm.power_state} if vm.power_state else {})}
            server = (await db.execute(select(Server).where(Server.cloud_ref == ref))).scalar_one_or_none()
            if server is None:
                if not ip or (cfg.get("only_running") and vm.power_state not in (None, "running")):
                    stats["skipped"] += 1
                    continue
                if account.review_new:
                    if await _queue_for_review(db, account, ref, vm, ip, os_type, {**vm.tags, **cloud_tags}):
                        stats["new_pending"] += 1
                    stats["pending"] += 1
                    continue
                await create_server(db, account, ref=ref, name=vm.name, computer_name=vm.computer_name, ip=ip,
                                    os_type=os_type, tags={**vm.tags, **cloud_tags}, resource_group=vm.resource_group)
                stats["created"] += 1
            else:
                if ip:
                    server.ip_address = ip
                server.os_type = os_type
                server.tags = merge_tags(server.tags, vm.tags, cloud_tags)
                server.cloud_state = "present"
                stats["updated"] += 1
        prefix = "azure:"
        known = (await db.execute(select(Server).where(Server.cloud_ref.like(f"{prefix}%")))).scalars().all()
        subs = {s.lower() for s in cfg.get("subscription_ids") or []}
        for s in known:
            in_scope = any(f"/subscriptions/{sub}/" in s.cloud_ref for sub in subs)
            if in_scope and s.cloud_ref not in seen and s.cloud_state != "missing":
                s.cloud_state = "missing"
                s.tags = {**(s.tags or {}), "azure_power": "deleted"}
                stats["missing"] += 1
        account.last_sync_status = "ok"
        account.last_sync_message = (f"{len(vms)} VM : {stats['created']} ajoutée(s), {stats['updated']} mise(s) à jour, "
                                     f"{stats['missing']} disparue(s), {stats['skipped']} ignorée(s)"
                                     + (f", {stats['pending']} en attente de revue" if stats["pending"] else ""))
    except Exception as e:  # noqa: BLE001
        await db.rollback()
        account = await db.get(CloudAccount, account.id)
        account.last_sync_status = "error"
        account.last_sync_message = f"{type(e).__name__}: {e}"[:1000]
        stats["error"] = account.last_sync_message
    finally:
        if own_client:
            await client.aclose()
    account.last_sync_at = datetime.now(timezone.utc)
    if actor_id:
        db.add(AuditLog(user_id=actor_id, action="cloud.sync", status="success" if "error" not in stats else "failure",
                        result=f"{account.name}: {account.last_sync_message}"[:500]))
    if stats.get("new_pending"):
        from app.services.notifications import notify
        await notify(db, "cloud.pending", f"{stats['new_pending']} nouvelle(s) VM à valider ({account.name})",
                     "Importer ou ignorer depuis Infrastructure > Cloud.", link="/infrastructure")
    await db.commit()
    return stats
