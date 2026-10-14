from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import func, literal_column, select

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
) -> list[SensorRead]:
    start = datetime.fromtimestamp(start_time, UTC)
    end = datetime.fromtimestamp(end_time, UTC)
    if end <= start:
        raise HTTPException(status_code=422, detail="end_time must be after start_time")
    filters = (
        SensorReading.sensor_type == type,
        SensorReading.time >= start,
        SensorReading.time <= end,
    )
    if interval == "raw":
        readings = db.scalars(
            select(SensorReading).where(*filters).order_by(SensorReading.time)
        ).all()
        return [
            SensorRead.model_validate(reading, from_attributes=True)
            for reading in readings
        ]

    bucket_width = {
        "1m": literal_column("INTERVAL '1 minute'"),
        "5m": literal_column("INTERVAL '5 minutes'"),
        "1h": literal_column("INTERVAL '1 hour'"),
        "1d": literal_column("INTERVAL '1 day'"),
    }[interval]
    bucketed_time = func.date_bin(
        bucket_width,
        SensorReading.time,
        literal_column("TIMESTAMPTZ '2000-01-01 00:00:00+00'"),
    )
    statement = (
        select(
            bucketed_time.label("time"),
            SensorReading.device_id,
            SensorReading.sensor_type,
            func.avg(SensorReading.value).label("value"),
        )
        .where(*filters)
        .group_by(bucketed_time, SensorReading.device_id, SensorReading.sensor_type)
        .order_by(bucketed_time, SensorReading.device_id)
    )
    return [
        SensorRead.model_validate(row)
        for row in db.execute(statement).mappings()
    ]


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
