"""SSH proxy with several organisations."""
# Run in the backend container on a migrated database, with the branch code on PYTHONPATH
# and a test server on port 8001 (see docs/saas-phase1.md).
import asyncio, sys
sys.path.insert(0, "/tmp/saas")
import asyncssh
from sqlalchemy import delete, select
from app.core import tenancy
from app.core.database import async_session
from app.models.base import UserRole
from app.models.identity import LoginEvent, UserSSHKey
from app.models.organization import Organization, OrgMembership
from app.models.user import User
from app.services.orgs import create_org

fails = []
def check(c, l):
    print(("OK   " if c else "FAIL ") + l); c or fails.append(l)

async def run(username, key, keys=b""):
    async with asyncssh.connect("127.0.0.1", 2223, username=username, client_keys=[key], known_hosts=None) as conn:
        proc = await conn.create_process(term_type="xterm", term_size=(100, 30))
        if keys:
            await asyncio.sleep(0.8); proc.stdin.write(keys.decode())
        out = ""
        try:
            while True:
                chunk = await asyncio.wait_for(proc.stdout.read(4096), 3)
                if not chunk: break
                out += chunk
        except asyncio.TimeoutError:
            pass
        proc.close()
        return out

async def main():
    key = asyncssh.generate_private_key("ssh-ed25519")
    async with async_session() as db:
        with tenancy.system():
            await db.execute(delete(Organization).where(Organization.slug == "acme-proxy"))
            await db.execute(delete(User).where(User.email == "proxy.test@example.org"))
            await db.commit()
            jf = (await db.execute(select(User).where(User.is_platform_admin).order_by(User.created_at))).scalars().first()
            default = (await db.execute(select(Organization).where(Organization.is_default))).scalar_one()
        org = await create_org(db, "Acme Proxy", "acme-proxy", None, jf)
        u = User(entra_object_id="proxy-test-oid", email="proxy.test@example.org", display_name="Proxy Test", is_active=True)
        db.add(u); await db.flush()
        db.add(OrgMembership(org_id=default.id, user_id=u.id, role=UserRole.VIEWER))
        db.add(OrgMembership(org_id=org.id, user_id=u.id, role=UserRole.OPERATOR))
        pub = key.export_public_key().decode().strip()
        db.add(UserSSHKey(user_id=u.id, name="test", public_key=pub, fingerprint=key.get_fingerprint("sha256")))
        await db.commit()
        uid, org_id = u.id, org.id
    try:
        out = await run("proxy.test@example.org#nope:srv", key)
        check("Organisation « nope » inconnue" in out, "unknown organisation prefix refused")
        out = await run("proxy.test@example.org#acme-proxy:ghost", key)
        check("Serveur « ghost » introuvable" in out, "org prefix accepted, server looked up in acme")
        out = await run("proxy.test@example.org", key)
        check("Organisation" in out and "Acme Proxy" in out and "Par défaut" in out, "menu offers both organisations")
        out = await run("proxy.test@example.org", key, b"acme\r")
        check("Aucun serveur Linux ni cluster" in out, "after choosing acme: acme's (empty) server list")
        async with async_session() as db:
            with tenancy.system():
                evs = (await db.execute(select(LoginEvent).where(LoginEvent.user_id == uid, LoginEvent.result == "success"))).scalars().all()
        check(any(e.org_id == org_id for e in evs) and all(e.org_id is not None for e in evs), f"sign-ins recorded with their organisation ({len(evs)})")
    finally:
        async with async_session() as db:
            with tenancy.system():
                await db.execute(delete(Organization).where(Organization.slug == "acme-proxy"))
                await db.execute(delete(LoginEvent).where(LoginEvent.user_id == uid))
                await db.execute(delete(User).where(User.id == uid))
                await db.commit()
    print(f"\n{len(fails)} failure(s)")

asyncio.run(main())
