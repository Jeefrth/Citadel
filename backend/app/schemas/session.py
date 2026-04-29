import uuid
from datetime import datetime

from pydantic import BaseModel


class SessionEvent(BaseModel):
    t: int  # milliseconds since session start
    type: str  # "o" (output) or "i" (input)
    data: str  # base64 encoded


class SessionRecordingList(BaseModel):
    id: uuid.UUID
    session_id: str
    server_id: uuid.UUID
    user_id: uuid.UUID
    server_name: str
    user_name: str
    started_at: datetime
    ended_at: datetime | None
    duration_seconds: int
    event_count: int
    size_bytes: int

    model_config = {"from_attributes": True}


class SessionRecordingDetail(SessionRecordingList):
    events: list[SessionEvent]
