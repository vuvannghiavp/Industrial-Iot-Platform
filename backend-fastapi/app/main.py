import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text, update

from app.api import auth, devices, users, websocket
from app.core.config import get_settings
from app.core.database import Base, SessionLocal, engine
from app.core.security import hash_password
from app.models import Device, User
from app.mqtt import MqttService

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


class WebSocketManager:
    def __init__(self) -> None:
        self.connections: set[WebSocket] = set()

    async def connect(self, websocket: WebSocket, subprotocol: str | None = None) -> None:
        await websocket.accept(subprotocol=subprotocol)
        self.connections.add(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        self.connections.discard(websocket)

    async def broadcast(self, event: dict) -> None:
        disconnected: list[WebSocket] = []
        for connection in self.connections:
            try:
                await connection.send_json(event)
            except Exception:
                disconnected.append(connection)
        for connection in disconnected:
            self.disconnect(connection)


def initialize_database() -> None:
    Base.metadata.create_all(bind=engine)
    with engine.begin() as connection:
        connection.execute(text("CREATE SEQUENCE IF NOT EXISTS sensor_readings_id_seq"))
        connection.execute(text("ALTER SEQUENCE sensor_readings_id_seq OWNED BY sensor_readings.id"))
        connection.execute(text(
            "ALTER TABLE sensor_readings ALTER COLUMN id "
            "SET DEFAULT nextval('sensor_readings_id_seq')"
        ))
        connection.execute(text(
            "SELECT setval('sensor_readings_id_seq', "
            "GREATEST(COALESCE(MAX(id), 0), "
            "(SELECT last_value FROM sensor_readings_id_seq)), true) "
            "FROM sensor_readings"
        ))
        connection.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_sensor_reading_device_time_type "
            "ON sensor_readings (time, device_id, sensor_type)"
        ))
        connection.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS fan_state BOOLEAN"
        ))
        connection.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS light_state BOOLEAN"
        ))
    # This becomes a no-op when TimescaleDB is unavailable, so local SQL tests
    # can still use the regular PostgreSQL schema.
    try:
        with engine.begin() as connection:
            connection.execute(text("CREATE EXTENSION IF NOT EXISTS timescaledb"))
            connection.execute(text("SELECT create_hypertable('sensor_readings', by_range('time'), if_not_exists => TRUE)"))
    except Exception:
        logging.getLogger(__name__).warning("Timescale hypertable initialization skipped", exc_info=True)
    settings = get_settings()
    if settings.bootstrap_admin_email and settings.bootstrap_admin_password:
        with SessionLocal() as db:
            if not db.query(User).filter(User.email == settings.bootstrap_admin_email.lower()).first():
                db.add(User(email=settings.bootstrap_admin_email.lower(), password_hash=hash_password(settings.bootstrap_admin_password), role="admin"))
                db.commit()


def mark_stale_devices_offline(timeout_seconds: int) -> list[dict[str, object]]:
    cutoff = datetime.now(UTC) - timedelta(seconds=timeout_seconds)
    statement = (
        update(Device)
        .where(
            Device.is_online.is_(True),
            Device.last_seen_at.is_not(None),
            Device.last_seen_at < cutoff,
        )
        .values(is_online=False)
        .returning(
            Device.id,
            Device.is_online,
            Device.last_seen_at,
        )
    )
    with SessionLocal() as db:
        devices = [dict(row) for row in db.execute(statement).mappings()]
        db.commit()
    return [
        {
            "device_id": device["id"],
            "is_online": device["is_online"],
            "last_seen_at": device["last_seen_at"].isoformat(),
        }
        for device in devices
    ]


async def monitor_device_status(app: FastAPI) -> None:
    settings = get_settings()
    while True:
        try:
            stale_devices = await asyncio.to_thread(
                mark_stale_devices_offline,
                settings.device_offline_timeout_seconds,
            )
            for device in stale_devices:
                await app.state.websocket_manager.broadcast(
                    {"event": "device_status", "data": device}
                )
        except Exception:
            logging.getLogger(__name__).exception("Device offline check failed")
        await asyncio.sleep(5)


@asynccontextmanager
async def lifespan(app: FastAPI):
    initialize_database()
    app.state.websocket_manager = WebSocketManager()
    app.state.mqtt = MqttService(app.state.websocket_manager, asyncio.get_running_loop())
    app.state.mqtt.start()
    status_task = asyncio.create_task(monitor_device_status(app))
    try:
        yield
    finally:
        status_task.cancel()
        try:
            await status_task
        except asyncio.CancelledError:
            pass
        app.state.mqtt.stop()


app = FastAPI(title="Smart Home API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip()
        for origin in get_settings().cors_origins.split(",")
        if origin.strip()
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Accept", "Authorization", "Content-Type"],
)
app.include_router(auth.router, prefix="/api/v1")
app.include_router(users.router, prefix="/api/v1")
app.include_router(devices.router, prefix="/api/v1")
app.include_router(websocket.router)


@app.get("/health", tags=["operations"])
def health() -> dict[str, str]:
    return {"status": "ok"}
