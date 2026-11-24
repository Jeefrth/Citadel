import ipaddress
import re
import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.models.governance import ChannelType, CommandAction, ConnectAction, RuleScope

HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


class TimeWindow(BaseModel):
    days: list[int] = Field(default_factory=lambda: list(range(7)))  # 0 = Monday
    start: str = "00:00"
    end: str = "23:59"

    @field_validator("days")
    @classmethod
    def _days(cls, v):
        if not v or any(d < 0 or d > 6 for d in v):
            raise ValueError("days must be within 0 (Monday) .. 6 (Sunday)")
        return sorted(set(v))

    @field_validator("start", "end")
    @classmethod
    def _hhmm(cls, v):
        if not HHMM.match(v):
            raise ValueError("time must be HH:MM")
        return v


class RuleTargets(BaseModel):
    description: str | None = None
    priority: int = Field(default=50, ge=0, le=10000)
    is_active: bool = True
    user_ids: list[uuid.UUID] = Field(default_factory=list)
    group_ids: list[uuid.UUID] = Field(default_factory=list)
    server_ids: list[uuid.UUID] = Field(default_factory=list)
    node_ids: list[uuid.UUID] = Field(default_factory=list)
    labels: list[str] = Field(default_factory=list)
    accounts: list[str] = Field(default_factory=list)
    approver_group_ids: list[uuid.UUID] = Field(default_factory=list)


class ConnectionRuleIn(RuleTargets):
    name: str = Field(min_length=1, max_length=255)
    scope: RuleScope = RuleScope.CONNECT
    action: ConnectAction = ConnectAction.DENY
    source_ips: list[str] = Field(default_factory=list)
    time_windows: list[TimeWindow] = Field(default_factory=list)

    @field_validator("source_ips")
    @classmethod
    def _cidrs(cls, v):
        out = []
        for c in v:
            c = c.strip()
            if not c:
                continue
            try:
                out.append(str(ipaddress.ip_network(c, strict=False)))
            except ValueError:
                raise ValueError(f"Invalid IP or CIDR: {c}")
        return out


class CommandRuleIn(RuleTargets):
    name: str = Field(min_length=1, max_length=255)
    action: CommandAction = CommandAction.DENY
    patterns: list[str] = Field(min_length=1)

    @field_validator("patterns")
    @classmethod
    def _regex(cls, v):
        out = []
        for p in v:
            if not p.strip():
                continue
            try:
                re.compile(p)
            except re.error as e:
                raise ValueError(f"Invalid regex '{p}': {e}")
            out.append(p)
        if not out:
            raise ValueError("At least one pattern is required")
        return out


class Ref(BaseModel):
    id: str
    name: str


class RuleRead(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    priority: int
    is_active: bool
    users: list[Ref]
    groups: list[Ref]
    servers: list[Ref]
    nodes: list[Ref]
    labels: list[str]
    accounts: list[str]
    approver_groups: list[Ref]
    created_at: datetime


class ConnectionRuleRead(RuleRead):
    scope: str
    action: str
    source_ips: list[str]
    time_windows: list[TimeWindow]


class CommandRuleRead(RuleRead):
    action: str
    patterns: list[str]


class CommandTestIn(BaseModel):
    command: str
    server_id: uuid.UUID
    user_id: uuid.UUID | None = None   # default: current admin
    account: str | None = None


class DecisionOut(BaseModel):
    action: str
    rule: str | None
    reason: str | None = None


# ── Approvals ──
class AccessRequestIn(BaseModel):
    server_ids: list[uuid.UUID] = Field(default_factory=list)
    node_ids: list[uuid.UUID] = Field(default_factory=list)
    actions: list[str] = Field(default_factory=lambda: ["connect"])
    accounts: list[str] = Field(default_factory=lambda: ["@ALL"])
    duration_hours: int = Field(default=8, ge=1, le=720)
    reason: str = Field(min_length=3, max_length=2000)


class DecisionIn(BaseModel):
    comment: str | None = Field(default=None, max_length=1000)


class ApprovalRead(BaseModel):
    id: uuid.UUID
    number: int
    kind: str
    status: str
    requester: Ref
    server: Ref | None
    account_username: str | None
    command: str | None
    reason: str | None
    payload: dict
    rule_name: str | None
    decided_by: Ref | None
    decided_at: datetime | None
    decision_comment: str | None
    expires_at: datetime
    grant_until: datetime | None
    used_at: datetime | None
    policy_id: uuid.UUID | None
    created_at: datetime
    can_decide: bool = False
    approvers_available: int = 0


# ── Notifications ──
class NotificationRead(BaseModel):
    id: uuid.UUID
    event: str
    level: str
    title: str
    body: str | None
    link: str | None
    read_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ChannelIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    type: ChannelType
    is_active: bool = True
    config: dict = Field(default_factory=dict)
    secret: str | None = None  # SMTP password or webhook URL; omitted on update = unchanged
    events: list[str] = Field(default_factory=list)
    min_level: str = Field(default="info", pattern="^(info|warning|critical)$")


class ChannelUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    is_active: bool | None = None
    config: dict | None = None
    secret: str | None = None
    events: list[str] | None = None
    min_level: str | None = Field(default=None, pattern="^(info|warning|critical)$")


class ChannelRead(BaseModel):
    id: uuid.UUID
    name: str
    type: str
    is_active: bool
    config: dict
    has_secret: bool
    events: list[str]
    min_level: str
    last_sent_at: datetime | None
    last_error: str | None
    created_at: datetime
