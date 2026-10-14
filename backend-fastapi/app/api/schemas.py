from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshRequest(BaseModel):
    refresh_token: str


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    role: Literal["admin", "user"] = "user"


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    email: EmailStr
    role: str
    is_active: bool
    created_at: datetime


class DeviceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    gateway_id: str
    name: str
    kind: str
    is_online: bool
    last_seen_at: datetime | None
    fan_state: bool | None
    light_state: bool | None


class SensorRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    time: datetime
    device_id: str
    sensor_type: str
    value: float


class AlertRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    device_id: str | None
    alert_type: str
    severity: str
    message: str
    created_at: datetime
    acknowledged: bool


class ControlCommand(BaseModel):
    action: Literal["turn_on", "turn_off"]
    target: Literal["fan", "light"]
