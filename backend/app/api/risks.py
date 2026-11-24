"""Risk findings (lot 7)."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import require_role, has_perm, require_perm
from app.core.database import get_db
from app.models.audit import AuditLog
from app.models.base import UserRole
from app.models.pam import RiskFinding
from app.models.settings import AppSetting
from app.models.user import User
from app.services import risks

router = APIRouter()
admin_only = require_role(UserRole.ADMIN)


def _read(r: RiskFinding) -> dict:
    return {"id": str(r.id), "key": r.key, "category": r.category, "severity": r.severity, "title": r.title,
            "detail": r.detail, "link": r.link, "first_seen": r.first_seen, "last_seen": r.last_seen,
            "resolved_at": r.resolved_at, "ignored": r.ignored, "ignored_by": r.ignored_by,
            "ignored_reason": r.ignored_reason}


@router.get("/risks")
async def list_risks(status: str = Query(default="open", pattern="^(open|ignored|resolved)$"),
                     db: AsyncSession = Depends(get_db), _: User = Depends(require_perm("audit"))):
    stmt = select(RiskFinding)
    if status == "open":
        stmt = stmt.where(RiskFinding.resolved_at.is_(None), RiskFinding.ignored.is_(False))
    elif status == "ignored":
        stmt = stmt.where(RiskFinding.resolved_at.is_(None), RiskFinding.ignored.is_(True))
    else:
        stmt = stmt.where(RiskFinding.resolved_at.is_not(None)).order_by(RiskFinding.resolved_at.desc()).limit(200)
    rows = (await db.execute(stmt)).scalars().all()
    rows = sorted(rows, key=lambda r: (risks.SEVERITY_ORDER.get(r.severity, 9), r.category, r.title)) if status != "resolved" else rows
    last = (await db.execute(select(AppSetting.value).where(AppSetting.key == risks.LAST_SCAN))).scalar_one_or_none()
    counts = {}
    for r in rows:
        counts[r.severity] = counts.get(r.severity, 0) + 1
    return {"last_scan": last, "counts": counts, "items": [_read(r) for r in rows]}


@router.post("/risks/scan")
async def scan_now(db: AsyncSession = Depends(get_db), user: User = Depends(require_perm("audit"))):
    stats = await risks.scan(db, notify_new=False)
    db.add(AuditLog(user_id=user.id, action="risks.scan", result=str(stats)))
    await db.commit()
    return stats


class IgnoreIn(BaseModel):
    ignored: bool
    reason: str | None = Field(default=None, max_length=500)


@router.post("/risks/{risk_id}/ignore")
async def ignore_risk(risk_id: uuid.UUID, data: IgnoreIn, db: AsyncSession = Depends(get_db),
                      user: User = Depends(admin_only)):
    r = await db.get(RiskFinding, risk_id)
    if not r:
        raise HTTPException(status_code=404, detail="Risk not found")
    if data.ignored and not (data.reason or "").strip():
        raise HTTPException(status_code=400, detail="Une raison est obligatoire pour ignorer un risque")
    r.ignored = data.ignored
    r.ignored_by = user.display_name if data.ignored else None
    r.ignored_reason = data.reason if data.ignored else None
    db.add(AuditLog(user_id=user.id, action="risk.ignore" if data.ignored else "risk.unignore",
                    result=f"{r.title}" + (f" : {data.reason}" if data.ignored else "")))
    await db.commit()
    return _read(r)
