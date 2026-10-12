from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.api.schemas import AlertRead, ControlCommand, DeviceRead, SensorRead
from app.models import Alert, Device, SensorReading

router = APIRouter(tags=["devices and sensors"])


@router.get("/devices", response_model=list[DeviceRead])
def list_devices(_user: CurrentUser, db: DbSession) -> list[Device]:
    return db.scalars(select(Device).order_by(Device.id)).all()


@router.get("/sensors/latest", response_model=list[SensorRead])
def latest_sensors(_user: CurrentUser, db: DbSession) -> list[SensorReading]:
    readings = db.scalars(select(SensorReading).order_by(SensorReading.time.desc()).limit(500)).all()
    # Latest point per device/sensor type, portable across PostgreSQL and tests.
    seen: set[tuple[str, str]] = set()
    return [r for r in readings if not ((key := (r.device_id, r.sensor_type)) in seen or seen.add(key))]


@router.get("/sensors/history", response_model=list[SensorRead])
def sensor_history(
    _user: CurrentUser,
    db: DbSession,
    type: str,
    start_time: int,
    end_time: int,
    interval: str = Query("raw", pattern=r"^(raw|1m|5m|1h|1d)$"),
) -> list[SensorReading]:
    # `interval` is accepted for UI compatibility. Raw points are returned;
    # production dashboards can add Timescale continuous aggregates for buckets.
    start = datetime.fromtimestamp(start_time, UTC)
    end = datetime.fromtimestamp(end_time, UTC)
    if end <= start:
        raise HTTPException(status_code=422, detail="end_time must be after start_time")
    return db.scalars(
        select(SensorReading).where(
            SensorReading.sensor_type == type,
            SensorReading.time >= start,
            SensorReading.time <= end,
        ).order_by(SensorReading.time)
    ).all()


@router.get("/alerts", response_model=list[AlertRead])
def list_alerts(_user: CurrentUser, db: DbSession, limit: int = Query(100, ge=1, le=500)) -> list[Alert]:
    return db.scalars(select(Alert).order_by(Alert.created_at.desc()).limit(limit)).all()


@router.post("/devices/{device_id}/control", status_code=status.HTTP_202_ACCEPTED)
def control_device(device_id: str, command: ControlCommand, request: Request, _user: CurrentUser, db: DbSession) -> dict:
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    accepted = request.app.state.mqtt.publish_command(device, command.model_dump())
    if not accepted:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="MQTT connection unavailable")
    return {"status": "queued", "device_id": device_id, "command": command}
