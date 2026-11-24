"""Reports (lot 6): JSON for the printable page, CSV for spreadsheets."""

import csv
import io
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import require_role
from app.core.database import get_db
from app.models.audit import AuditLog
from app.models.base import UserRole
from app.models.user import User
from app.services.reports import REPORTS, csv_safe

router = APIRouter()
admin_only = require_role(UserRole.ADMIN)


def _cell(v):
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, bool):
        return "oui" if v else "non"
    return csv_safe(v)


@router.get("/reports/{kind}")
async def get_report(kind: str, request: Request,
                     date_from: datetime | None = None, date_to: datetime | None = None,
                     format: str = Query(default="json", pattern="^(json|csv)$"),
                     db: AsyncSession = Depends(get_db), user: User = Depends(admin_only)):
    if kind not in REPORTS:
        raise HTTPException(status_code=404, detail="Unknown report")
    end = date_to or datetime.now(timezone.utc)
    start = date_from or end - timedelta(days=30)
    if start >= end:
        raise HTTPException(status_code=400, detail="date_from must be before date_to")
    fn, title = REPORTS[kind]
    rows = await fn(db, start, end)
    db.add(AuditLog(user_id=user.id, action="report.view", ip_address=getattr(request.state, "client_ip", None),
                    result=f"{kind} {start.date()}..{end.date()} ({format})"))
    await db.commit()
    if format == "json":
        return {"kind": kind, "title": title, "from": start, "to": end,
                "generated_at": datetime.now(timezone.utc), "generated_by": user.display_name, "rows": rows}
    buf = io.StringIO()
    w = csv.writer(buf)
    if rows:
        w.writerow(list(rows[0].keys()))
        for r in rows:
            w.writerow([_cell(v) for v in r.values()])
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f"attachment; filename=citadel-rapport-{kind}.csv"})
