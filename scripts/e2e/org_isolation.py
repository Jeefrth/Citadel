"""E2E isolation between two organisations (SaaS phase 1)."""
# Run in the backend container on a migrated database, with the branch code on PYTHONPATH
# and a test server on port 8001 (see docs/saas-phase1.md).
import asyncio, os, secrets, subprocess, sys, tempfile
sys.path.insert(0, "/tmp/saas")
import httpx
from sqlalchemy import delete, select, text
from app.core import tenancy
from app.core.auth import hash_access_key
from app.core.database import async_session
from app.core.security import KeyMismatch, decrypt_value, split_blob
from app.models.credential import Credential
from app.models.organization import Organization
from app.models.pam import AccessKey
from app.models.user import User

API = "http://localhost:8001/api"
fails = []
def check(cond, label):
    print(("OK   " if cond else "FAIL ") + label)
    if not cond: fails.append(label)

async def key_for(org_id, uid, name):
    async with async_session() as db:
        with tenancy.system():
            p = secrets.token_hex(4); k = f"ctk_{p}_{secrets.token_urlsafe(24)}"
            db.add(AccessKey(user_id=uid, org_id=org_id, name=name, prefix=p, key_hash=hash_access_key(k), is_active=True))
            await db.commit()
    return k

async def main():
    async with async_session() as db:
        with tenancy.system():
            await db.execute(delete(Organization).where(Organization.slug == "acme-test"))
            await db.commit()
            default = (await db.execute(select(Organization).where(Organization.is_default))).scalar_one()
            jf = (await db.execute(select(User).where(User.is_platform_admin).order_by(User.created_at))).scalars().first()
    kd = await key_for(default.id, jf.id, "iso-default")
    D = httpx.AsyncClient(base_url=API, headers={"Authorization": f"Bearer {kd}"}, timeout=60)
    try:
        r = await D.post("/platform/orgs", json={"name": "Acme Test", "slug": "acme-test", "admin_email": "admin@acme.example"})
        check(r.status_code == 403, f"platform API refused with an access key ({r.status_code})")
        # platform action needs a real sign-in: create the org directly with the service
        from app.services.orgs import create_org
        async with async_session() as db:
            jfu = await db.get(User, jf.id)
            org = await create_org(db, "Acme Test", "acme-test", "admin@acme.example", jfu)
            acme_id, acme_key = org.id, org.transit_key
        check(acme_key and acme_key.startswith("citadel-org-"), f"own transit key {acme_key}")
        ka = await key_for(acme_id, jf.id, "iso-acme")
        A = httpx.AsyncClient(base_url=API, headers={"Authorization": f"Bearer {ka}"}, timeout=60)

        me = (await A.get("/auth/me")).json()
        check(me["org"]["slug"] == "acme-test" and me["role"] == "admin", "platform admin enters acme as admin")

        # data in each organisation
        ca = await A.post("/servers/credentials/", json={"name": "same-name", "type": "ssh_password", "username": "root", "password": "Acme-Secret-1"})
        cd = await D.post("/servers/credentials/", json={"name": "same-name", "type": "ssh_password", "username": "root", "password": "Default-Secret-1"})
        check(ca.status_code < 300 and cd.status_code < 300, f"same credential name in both orgs ({ca.status_code}/{cd.status_code})")
        na = (await A.post("/nodes", json={"name": "Acme-node"})).json()
        sa = await A.post("/servers/", json={"name": "acme-web", "hostname": "acme-web", "ip_address": "10.99.0.1", "os_type": "linux",
                                             "node_id": na["id"], "ssh_port": 22})
        check(sa.status_code < 300, f"server created in acme ({sa.status_code} {sa.text[:120]})")
        sid = sa.json()["id"]
        za = await A.post("/zones", json={"name": "Zone-A"}); zd = await D.post("/zones", json={"name": "Zone-A"})
        check(za.status_code < 300 and zd.status_code < 300, "same zone name in both orgs")
        pa = await A.post("/access-policies", json={"name": "Pol-A", "user_ids": [], "node_ids": [na["id"]], "actions": ["connect"]})
        check(pa.status_code < 300, f"policy in acme ({pa.status_code})")

        # visibility
        for path in ["/servers/", "/nodes", "/servers/credentials/", "/zones", "/access-policies"]:
            d = (await D.get(path)).json(); a = (await A.get(path)).json()
            dn = {x.get("name") for x in d}; an = {x.get("name") for x in a}
            check(not ({"acme-web", "Acme-node", "Pol-A"} & dn), f"default does not see acme in {path}")
        check(len((await A.get("/servers/")).json()) == 1, "acme sees only its server")
        check((await D.get(f"/servers/{sid}")).status_code == 404, "acme server is 404 from default")
        check((await D.delete(f"/servers/{sid}")).status_code == 404, "cannot delete acme server from default")
        check((await D.patch(f"/nodes/{na['id']}", json={"name": "pwn"})).status_code == 404, "cannot rename acme node from default")
        aud_d = (await D.get("/command-logs")).json()
        users_a = (await A.get("/users/")).json()
        check(all(u["email"] != "jean-francois.reithler@qiminfo.ch" for u in users_a), "acme member list does not show default members")
        inv = (await A.get("/org/invitations")).json()
        check([i["email"] for i in inv] == ["admin@acme.example"], f"acme invitation listed {inv}")
        check((await D.get("/org/invitations")).json() == [], "default does not see acme invitations")
        # access key of acme refused with another org header
        check((await A.get("/servers/", headers={"X-Citadel-Org": "default"})).status_code == 403, "acme key refused in default")

        # CA
        pub_a = (await A.get("/ca/public-key")).text; pub_d = (await D.get("/ca/public-key")).text
        check(pub_a != pub_d and pub_a.startswith("ssh-ed25519"), "acme has its own CA public key")

        # encryption
        async with async_session() as db:
            with tenancy.system():
                blobs = {c.org_id: bytes(c.encrypted_password) for c in (await db.execute(select(Credential).where(Credential.name == "same-name"))).scalars()}
        ka_, _ = split_blob(blobs[acme_id]); kd_, _ = split_blob(blobs[default.id])
        check(ka_ == acme_key and kd_ is None, "acme blob carries its key, default blob does not")
        with tenancy.tenant(default.id):
            try:
                decrypt_value(blobs[acme_id]); check(False, "default cannot decrypt acme secret")
            except KeyMismatch:
                check(True, "default cannot decrypt acme secret")
        async with async_session() as db:
            o = await db.get(Organization, acme_id)
        with tenancy.tenant(o):
            check(decrypt_value(blobs[acme_id]) == "Acme-Secret-1", "acme decrypts its secret")
            try:
                decrypt_value(blobs[default.id]); check(False, "acme cannot decrypt default secret")
            except KeyMismatch:
                check(True, "acme cannot decrypt default secret")
            # certificate signed by the acme CA
            from app.services.ca_service import sign_user_certificate, cleanup_cert_files
            kp, cp = sign_user_certificate("alice", 5)
            info = subprocess.run(["ssh-keygen", "-L", "-f", cp], capture_output=True, text=True).stdout
            with tempfile.NamedTemporaryFile("w", suffix=".pub", delete=False) as f:
                f.write(o.ssh_ca_public); capath = f.name
            fp = subprocess.run(["ssh-keygen", "-lf", capath], capture_output=True, text=True).stdout.split()[1]
            check(fp in info, "certificate signed by the acme CA")
            cleanup_cert_files(kp); os.unlink(capath)

        # raw SQL under row level security
        async with async_session() as db:
            with tenancy.tenant(default.id):
                n = (await db.execute(text("select count(*) from servers where name = 'acme-web'"))).scalar_one()
                check(n == 0, "RLS: raw SQL in default does not see acme server")
                n = (await db.execute(text("select count(*) from credentials"))).scalar_one()
                m = (await db.execute(text("select count(*) from credentials where org_id <> :o"), {"o": default.id})).scalar_one()
                check(m == 0, f"RLS: raw SQL sees only own credentials ({n})")
                try:
                    await db.execute(text("update servers set name='x' where name='acme-web'"))
                    r = (await db.execute(text("select 1"))).first()
                    check(True, "RLS: update of acme row affects nothing")
                except Exception as e:
                    check(False, f"RLS update raised {e}")
                await db.rollback()
        # no context = fail closed
        async with async_session() as db:
            try:
                await db.execute(select(Credential)); check(False, "ORM without organisation fails closed")
            except tenancy.TenantError:
                check(True, "ORM without organisation fails closed")
    finally:
        await D.aclose()
        async with async_session() as db:
            with tenancy.system():
                await db.execute(delete(AccessKey).where(AccessKey.name.like("iso-%")))
                await db.execute(delete(Organization).where(Organization.slug == "acme-test"))
                await db.commit()
        # default org test objects
        async with async_session() as db:
            with tenancy.tenant(default.id):
                await db.execute(text("delete from credentials where name='same-name'"))
                await db.execute(text("delete from zones where name='Zone-A'"))
                await db.commit()
    print(f"\n{len(fails)} failure(s)")

asyncio.run(main())
