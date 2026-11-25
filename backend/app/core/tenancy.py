"""Multi-organisation isolation (SaaS phase 1).

Every row that belongs to a customer carries an org_id (TenantMixin). The
current organisation lives in a context variable, set once per request /
WebSocket / proxy session / background job:

- ORM: every SELECT / UPDATE / DELETE on a tenant model gets
  "org_id = current org" added automatically (with_loader_criteria), and
  new tenant rows get the current org_id; writing a row of another org
  raises.
- Postgres: each transaction switches to the non-privileged role
  citadel_rls and sets app.org_id; row level security policies then refuse
  rows of other organisations even if a query slipped through the ORM.
- No context = fail closed: a tenant query without an organisation raises.
  Platform code (startup, scheduler iteration, auth lookups by key) runs in
  an explicit system() block.
"""

import contextlib
import uuid
from contextvars import ContextVar
from dataclasses import dataclass

from sqlalchemy import ForeignKey, event, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, ORMExecuteState, Session, declared_attr, mapped_column, with_loader_criteria

RLS_ROLE = "citadel_rls"


@dataclass(frozen=True)
class TenantContext:
    org_id: uuid.UUID | None = None
    transit_key: str | None = None      # None = default key (settings)
    bypass: bool = False                # platform / system code


_ctx: ContextVar[TenantContext | None] = ContextVar("citadel_tenant", default=None)


class TenantError(RuntimeError):
    pass


def current() -> TenantContext | None:
    return _ctx.get()


def current_org_id() -> uuid.UUID | None:
    c = _ctx.get()
    return c.org_id if c else None


def require_org_id() -> uuid.UUID:
    c = _ctx.get()
    if c is None or c.org_id is None:
        raise TenantError("No organisation in context")
    return c.org_id


def set_context(ctx: TenantContext | None):
    """Set for the rest of the current task (and tasks it creates). Returns a reset token."""
    return _ctx.set(ctx)


def reset_context(token) -> None:
    _ctx.reset(token)


@contextlib.contextmanager
def tenant(org_id: uuid.UUID, transit_key: str | None = None):
    token = _ctx.set(TenantContext(org_id=org_id, transit_key=transit_key))
    try:
        yield
    finally:
        _ctx.reset(token)


@contextlib.contextmanager
def system():
    """Platform code that legitimately spans organisations (keep it short)."""
    token = _ctx.set(TenantContext(bypass=True))
    try:
        yield
    finally:
        _ctx.reset(token)


class TenantMixin:
    """Row owned by an organisation."""
    __tenant_nullable__ = False   # audit_logs: platform events have no organisation

    @declared_attr
    def org_id(cls) -> Mapped[uuid.UUID]:
        return mapped_column(UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"),
                             nullable=cls.__tenant_nullable__, index=True)


# ── ORM enforcement ──

@event.listens_for(Session, "do_orm_execute")
def _filter_by_org(state: ORMExecuteState) -> None:
    if not (state.is_select or state.is_update or state.is_delete):
        return
    if state.execution_options.get("citadel_skip_tenant"):
        return
    ctx = _ctx.get()
    if ctx is not None and ctx.bypass:
        return
    if ctx is None or ctx.org_id is None:
        # Fail closed, but only when the statement touches a tenant model
        mappers = [m.class_ for m in state.all_mappers] if hasattr(state, "all_mappers") else []
        if any(issubclass(c, TenantMixin) for c in mappers):
            raise TenantError("Tenant data queried without an organisation")
        return
    org_id = ctx.org_id
    state.statement = state.statement.options(
        with_loader_criteria(TenantMixin, lambda cls: cls.org_id == org_id, include_aliases=True)
    )


@event.listens_for(Session, "before_flush")
def _stamp_org(session: Session, flush_context, instances) -> None:
    ctx = _ctx.get()
    for obj in list(session.new) + list(session.dirty):
        if not isinstance(obj, TenantMixin):
            continue
        if ctx is not None and ctx.bypass:
            if obj.org_id is None and not type(obj).__tenant_nullable__:
                raise TenantError(f"{type(obj).__name__} written in system mode without org_id")
            continue
        if ctx is None or ctx.org_id is None:
            if type(obj).__tenant_nullable__ and obj.org_id is None and obj in session.new:
                continue   # platform event (sign-in refused before any organisation)
            raise TenantError(f"{type(obj).__name__} written without an organisation")
        if obj.org_id is None:
            obj.org_id = ctx.org_id
        elif obj.org_id != ctx.org_id:
            raise TenantError(f"{type(obj).__name__} of another organisation")


# ── Postgres row level security ──

def _rls_sql(ctx: TenantContext | None) -> tuple[str, dict]:
    org = str(ctx.org_id) if ctx and ctx.org_id else ""
    bypass = "on" if ctx and ctx.bypass else "off"
    return ("SELECT set_config('app.org_id', :org, true), set_config('app.bypass', :bypass, true)",
            {"org": org, "bypass": bypass})


@event.listens_for(Session, "after_begin")
def _apply_rls(session: Session, transaction, connection) -> None:
    sql, params = _rls_sql(_ctx.get())
    connection.execute(text(f"SET LOCAL ROLE {RLS_ROLE}"))
    connection.execute(text(sql), params)


async def apply_to_session(db) -> None:
    """Re-apply the context inside an already open transaction (after a switch)."""
    if not db.in_transaction():
        return
    sql, params = _rls_sql(_ctx.get())
    await db.execute(text(sql), params)
