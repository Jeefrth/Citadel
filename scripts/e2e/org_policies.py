"""E2E per-organisation policies (SaaS phase 2): address allow-list, rate limit,
approval numbering per organisation, platform console.

Run in the backend container on a migrated database, with the branch code on
PYTHONPATH and a test server on port 8001 (see docs/saas-phase2.md).
"""
import asyncio
import json
import secrets
import sys

sys.path.insert(0, "/tmp/saas")
import httpx
from sqlalchemy import delete, select

from app.core import tenancy
from app.core.auth import hash_access_key
from app.core.database import async_session
from app.models.audit import AuditLog
from app.models.base import UserRole
from app.models.organization import OrgMembership, Organization
from app.models.pam import AccessKey
from app.models.settings import AppSetting
from app.models.user import User

API = "http://localhost:8001/api"
fails = []


def check(c, label):
    print(("OK   " if c else "FAIL ") + label)
    c or fails.append(label)


async def key_for(org_id, uid, name):
    async with async_session() as db:
        with tenancy.system():
            p = secrets.token_hex(4)
            k = f"ctk_{p}_{secrets.token_urlsafe(24)}"
            db.add(AccessKey(user_id=uid, org_id=org_id, name=name, prefix=p, key_hash=hash_access_key(k), is_active=True))
            await db.commit()
    return k


async def set_org_setting(org_id, key, value):
    async with async_session() as db:
        with tenancy.system():
            row = (await db.execute(select(AppSetting).where(AppSetting.org_id == org_id, AppSetting.key == key))).scalar_one_or_none()
            if row is None:
                db.add(AppSetting(org_id=org_id, key=key, value=value))
            else:
                row.value = value
            await db.commit()


async def main():
    from app.services.orgs import create_org
    async with async_session() as db:
        with tenancy.system():
            await db.execute(delete(Organization).where(Organization.slug.in_(["pol-a", "pol-b"])))
            await db.execute(delete(User).where(User.entra_object_id == "pol-member"))
            await db.commit()
            jf = (await db.execute(select(User).where(User.is_platform_admin))).scalars().first()
    async with async_session() as db:
        a = await create_org(db, "Pol A", "pol-a", None, jf)
        a_id = a.id
    async with async_session() as db:
        b = await create_org(db, "Pol B", "pol-b", None, jf)
        b_id = b.id
    async with async_session() as db:
        with tenancy.system():
            m = User(entra_object_id="pol-member", email="member@pol.test", display_name="Pol Member", is_active=True)
            db.add(m)
            await db.flush()
            db.add(OrgMembership(org_id=a_id, user_id=m.id, role=UserRole.ADMIN))
            db.add(OrgMembership(org_id=b_id, user_id=m.id, role=UserRole.ADMIN))
            await db.commit()
            mid = m.id
    ka, kb, kp = await key_for(a_id, mid, "pol"), await key_for(b_id, mid, "pol"), await key_for(a_id, jf.id, "pol")
    A = httpx.AsyncClient(base_url=API, headers={"Authorization": f"Bearer {ka}"}, timeout=30)
    B = httpx.AsyncClient(base_url=API, headers={"Authorization": f"Bearer {kb}"}, timeout=30)
    P = httpx.AsyncClient(base_url=API, headers={"Authorization": f"Bearer {kp}"}, timeout=30)
    try:
        # Allow-list
        check((await A.get("/servers/")).status_code == 200, "no allow-list: access")
        r = await A.put("/admin/settings/ip_allowlist", json={"value": json.dumps(["10.99.0.0/16"])})
        check(r.status_code == 400 and "perdriez" in r.text, "an admin cannot lock themselves out")
        r = await A.put("/admin/settings/ip_allowlist", json={"value": json.dumps(["not-an-ip"])})
        check(r.status_code == 400, "invalid allow-list entry refused")
        await set_org_setting(a_id, "ip_allowlist", json.dumps(["10.99.0.0/16"]))
        r = await A.get("/servers/")
        check(r.status_code == 403 and "Adresse IP" in r.text, "address outside the allow-list refused")
        check((await B.get("/servers/")).status_code == 200, "the other organisation is not affected")
        r = await P.get("/servers/")
        check(r.status_code == 200, "platform admin keeps access (support)")
        async with async_session() as db:
            with tenancy.system():
                n = (await db.execute(select(AuditLog).where(AuditLog.org_id == a_id, AuditLog.action == "ip_allowlist.bypass"))).first()
        check(n is not None, "...and that access is audited")
        await set_org_setting(a_id, "ip_allowlist", json.dumps(["127.0.0.0/8", "::1/128"]))
        check((await A.get("/servers/")).status_code == 200, "address in the allow-list accepted")
        await set_org_setting(a_id, "ip_allowlist", "[]")

        # Rate limit per person and organisation
        r = await A.put("/admin/settings/rate_limit_requests", json={"value": "5"})
        check(r.status_code == 400, "rate limit below 30 refused (would break the interface)")
        await set_org_setting(a_id, "rate_limit_requests", "30")
        await set_org_setting(a_id, "rate_limit_window_seconds", "60")
        codes = [(await A.get("/auth/me")).status_code for _ in range(33)]
        check(429 in codes and codes[:25].count(200) == 25, f"rate limit reached after 30 requests ({codes.count(429)} refused)")
        check((await B.get("/auth/me")).status_code == 200, "limit counted per organisation")
        await set_org_setting(a_id, "rate_limit_requests", "0")

        # Approval numbers per organisation
        from app.core.governance import request_approval
        nums = {}
        for org_id in (a_id, b_id, a_id):
            async with async_session() as db:
                o = await db.get(Organization, org_id)
                with tenancy.tenant(o):
                    await tenancy.apply_to_session(db)
                    from app.services.members import load_member
                    u = await load_member(db, mid)
                    from types import SimpleNamespace
                    dec = SimpleNamespace(rule="test", approver_group_ids=[], action="review")
                    req = await request_approval(db, u, "access", dec, reason="test", payload={"duration_hours": 1})
                    nums.setdefault(str(org_id), []).append(req.number)
        check(nums[str(a_id)] == [1, 2] and nums[str(b_id)] == [1], f"request numbers per organisation {nums}")

        # Platform console
        ov = await P.get("/platform/overview")
        check(ov.status_code == 403, "platform console refused with an access key")
        from app.api.platform import overview, platform_audit
        async with async_session() as db:
            jfu = await db.get(User, jf.id)
            data = await overview(db, jfu)
            aud = await platform_audit(100, 0, db, jfu)
        names = {o["slug"]: o for o in data["organisations"]}
        check("pol-a" in names and names["pol-a"]["members"] == 1, "overview counts members per organisation")
        check(any(i["action"] == "org.create" and i["organisation"] == "Pol A" for i in aud["items"]), "platform journal lists organisation events")
        check(any(i["action"] == "ip_allowlist.bypass" for i in aud["items"]), "platform journal lists allow-list bypasses")
    finally:
        for c in (A, B, P):
            await c.aclose()
        async with async_session() as db:
            with tenancy.system():
                await db.execute(delete(AccessKey).where(AccessKey.name == "pol"))
                await db.execute(delete(Organization).where(Organization.slug.in_(["pol-a", "pol-b"])))
                from sqlalchemy import text
                await db.execute(text("delete from audit_logs where user_id = :u"), {"u": mid})
                await db.execute(delete(User).where(User.id == mid))
                await db.commit()
    print(f"\n{len(fails)} failure(s)")


asyncio.run(main())
