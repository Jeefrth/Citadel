"""Register the test lab in Citadel through the API (idempotent: existing objects are kept).

Run inside the backend container (scripts/test-lab.sh provision does it):
    python /tmp/lab_provision.py
Needs /tmp/k3s.token and /tmp/k3s-ca.crt for the Kubernetes cluster.
Uses a temporary admin access key, removed at the end.
"""
import asyncio
import os
import secrets
import sys

sys.path.insert(0, "/app")
import httpx  # noqa: E402
from sqlalchemy import delete, select  # noqa: E402

from app.core.auth import hash_access_key  # noqa: E402
from app.core.database import async_session  # noqa: E402
from app.models.base import UserRole  # noqa: E402
from app.models.pam import AccessKey  # noqa: E402
from app.models.user import User  # noqa: E402

API = "http://localhost:8000/api"
PW_ADMIN, PW_USER, PW_GW = "Lab-Admin-2026", "Lab-User-2026", "Lab-Gw-2026"


async def main():
    async with async_session() as db:
        admin = (await db.execute(select(User).where(User.role == UserRole.ADMIN).order_by(User.created_at))).scalars().first()
        prefix = secrets.token_hex(4)
        key = f"ctk_{prefix}_{secrets.token_urlsafe(24)}"
        db.add(AccessKey(user_id=admin.id, name="lab-provision", prefix=prefix, key_hash=hash_access_key(key), is_active=True))
        await db.commit()
        me = (admin.email or "").split("@")[0]
        others = [str(u.id) for u in (await db.execute(select(User).where(User.id != admin.id, User.is_active.is_(True)))).scalars().all()
                  if not u.entra_object_id.startswith("dev-mode")]
    c = httpx.AsyncClient(base_url=API, headers={"Authorization": f"Bearer {key}"}, timeout=60)

    async def ok(r, what):
        if r.status_code >= 400:
            raise SystemExit(f"{what}: {r.status_code} {r.text[:300]}")
        return r.json()

    try:
        # Nodes
        nodes = {n["name"]: n for n in await ok(await c.get("/nodes"), "nodes")}
        if "Labo" not in nodes:
            nodes["Labo"] = await ok(await c.post("/nodes", json={"name": "Labo", "description": "Laboratoire de test"}), "node Labo")
        labo = nodes["Labo"]["id"]
        web = next((n for n in nodes.values() if n["name"] == "Web" and n.get("parent_id") == labo), None)
        if web is None:
            web = await ok(await c.post("/nodes", json={"name": "Web", "parent_id": labo}), "node Web")

        # Credentials
        creds = {x["name"]: x for x in await ok(await c.get("/servers/credentials/"), "credentials")}
        for name, ctype, user, pw in [("lab-deploy", "ssh_password", "deploy", PW_ADMIN), ("lab-alice", "ssh_password", "alice", PW_USER),
                                      ("lab-gw", "ssh_password", "gw", PW_GW), ("lab-rdp", "winrm", "ubuntu", "ubuntu")]:
            if name not in creds:
                creds[name] = await ok(await c.post("/servers/credentials/", json={"name": name, "type": ctype, "username": user, "password": pw}), f"credential {name}")

        # Zone + gateway
        zones = {z["name"]: z for z in await ok(await c.get("/zones"), "zones")}
        if "Isolée" not in zones:
            zones["Isolée"] = await ok(await c.post("/zones", json={"name": "Isolée", "description": "Réseau joignable seulement par lab-gw"}), "zone")
        zone = zones["Isolée"]
        if not any(g["name"] == "lab-gw" for g in zone.get("gateways", [])):
            await ok(await c.post(f"/zones/{zone['id']}/gateways", json={"name": "lab-gw", "host": "lab-gw", "username": "gw",
                                                                         "credential_id": creds["lab-gw"]["id"], "priority": 10}), "gateway")

        # Servers
        servers = {s["name"]: s for s in await ok(await c.get("/servers/"), "servers")}
        wanted = [
            ("lab-linux", "linux", labo, None, {"env": "labo", "role": "web"}, "deploy", "lab-deploy"),
            ("lab-linux2", "linux", web["id"], None, {"env": "labo", "role": "app"}, "deploy", "lab-deploy"),
            ("lab-isolated", "linux", labo, zone["id"], {"env": "labo", "role": "isolated"}, "deploy", "lab-deploy"),
            ("lab-rdp", "windows", labo, None, {"env": "labo", "role": "desktop"}, "ubuntu", "lab-rdp"),
        ]
        for name, os_type, node, zone_id, tags, acc, cred in wanted:
            if name in servers:
                continue
            body = {"name": name, "hostname": name, "ip_address": name, "os_type": os_type, "node_id": node, "zone_id": zone_id,
                    "tags": tags, "ssh_port": 22, "rdp_port": 3389,
                    "default_account": {"username": acc, "credential_id": creds[cred]["id"], "privileged": True}}
            servers[name] = await ok(await c.post("/servers/", json=body), f"server {name}")
        for name in ("lab-linux", "lab-linux2"):
            sid = servers[name]["id"]
            existing = {a["username"] for a in await ok(await c.get(f"/servers/{sid}/accounts"), "accounts")}
            if "alice" not in existing:
                await ok(await c.post(f"/servers/{sid}/accounts", json={"username": "alice", "credential_id": creds["lab-alice"]["id"]}), "alice")
            if me and me not in existing:
                await ok(await c.post(f"/servers/{sid}/accounts", json={"username": me, "use_cert": True,
                                                                         "description": "certificat éphémère (CA Citadel)"}), "cert account")

        # Kubernetes cluster
        clusters = {k["name"]: k for k in await ok(await c.get("/k8s/clusters"), "clusters")}
        if "lab-k3s" not in clusters and os.path.exists("/tmp/k3s.token"):
            clusters["lab-k3s"] = await ok(await c.post("/k8s/clusters", json={
                "name": "lab-k3s", "description": "k3s du laboratoire", "api_url": "https://lab-k3s:6443",
                "ca_cert": open("/tmp/k3s-ca.crt").read(), "token": open("/tmp/k3s.token").read().strip(),
                "node_id": labo, "tags": {"env": "labo"}}), "cluster")
        elif "lab-k3s" in clusters and os.path.exists("/tmp/k3s.token"):
            # the lab was recreated: new token and CA for the same address
            await ok(await c.patch(f"/k8s/clusters/{clusters['lab-k3s']['id']}", json={
                "name": "lab-k3s", "description": "k3s du laboratoire", "api_url": "https://lab-k3s:6443",
                "ca_cert": open("/tmp/k3s-ca.crt").read(), "token": open("/tmp/k3s.token").read().strip(),
                "node_id": labo, "tags": {"env": "labo"}}), "cluster update")

        # Access rules for the other users (2nd account, lab users)
        if others:
            if not any(p["name"] == "Labo" for p in await ok(await c.get("/access-policies"), "policies")):
                await ok(await c.post("/access-policies", json={"name": "Labo", "user_ids": others, "node_ids": [labo],
                                                                "actions": ["connect", "execute", "upload", "download"],
                                                                "accounts": ["alice", "@USER"]}), "policy Labo")
            if "lab-k3s" in clusters and not any(p["name"] == "Labo k8s" for p in await ok(await c.get("/k8s/policies"), "k8s policies")):
                await ok(await c.post("/k8s/policies", json={"name": "Labo k8s", "user_ids": others, "cluster_ids": [clusters["lab-k3s"]["id"]],
                                                             "namespaces": ["demo", "team-*"], "actions": ["view", "logs", "exec", "manage"]}), "k8s policy")

        # Checks
        print("Serveurs :")
        for name in ("lab-linux", "lab-linux2", "lab-isolated", "lab-rdp"):
            r = await c.post(f"/servers/{servers[name]['id']}/test-connection")
            res = r.json() if r.status_code < 500 else {}
            state = "OK" if res.get("success") else ("RDP seulement (pas de WinRM)" if name == "lab-rdp" else f"échec : {res.get('message') or r.text[:120]}")
            print(f"  {name:<13} {state}")
        if "lab-k3s" in clusters:
            k = await ok(await c.post(f"/k8s/clusters/{clusters['lab-k3s']['id']}/check"), "cluster check")
            print(f"Cluster :\n  lab-k3s       {k['last_check_status']} {k.get('version') or ''} {k.get('last_check_message') or ''}")
        print(f"Règles d'accès pour {len(others)} autre(s) utilisateur(s) : « Labo » (serveurs) et « Labo k8s »." if others
              else "Aucun autre utilisateur : pas de règle d'accès créée (lancez « users » puis « provision » pour en avoir).")
    finally:
        await c.aclose()
        async with async_session() as db:
            await db.execute(delete(AccessKey).where(AccessKey.name == "lab-provision"))
            await db.commit()


asyncio.run(main())
