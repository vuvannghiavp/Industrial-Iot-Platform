"""AWS IoT Core subscriber/publisher backed by Paho MQTT's network thread."""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import paho.mqtt.client as mqtt
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.core.config import Settings, get_settings
from app.core.database import SessionLocal
from app.models import Alert, Device, SensorReading

LOG = logging.getLogger(__name__)


class MqttService:
    def __init__(self, websocket_manager: Any, event_loop: asyncio.AbstractEventLoop, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.websocket_manager = websocket_manager
        self.event_loop = event_loop
        self.client: mqtt.Client | None = None
        self.connected = False

    def start(self) -> None:
        if not self.settings.mqtt_enabled:
            LOG.warning("MQTT integration disabled (MQTT_ENABLED=false)")
            return
        required_paths = [self.settings.aws_iot_ca_file, self.settings.aws_iot_cert_file, self.settings.aws_iot_key_file]
        if not self.settings.aws_iot_endpoint or not all(path and Path(path).is_file() for path in required_paths):
            LOG.error("AWS IoT configuration/certificates missing; MQTT client not started")
            return
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="smarthome-fastapi", clean_session=False)
        self.client.reconnect_delay_set(min_delay=1, max_delay=60)
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_message = self._on_message
        self.client.tls_set(
            ca_certs=self.settings.aws_iot_ca_file,
            certfile=self.settings.aws_iot_cert_file,
            keyfile=self.settings.aws_iot_key_file,
        )
        self.client.connect_async(self.settings.aws_iot_endpoint, self.settings.aws_iot_port, keepalive=60)
        self.client.loop_start()

    def stop(self) -> None:
        if self.client:
            self.client.loop_stop()
            self.client.disconnect()

    def _on_connect(self, client: mqtt.Client, _userdata: Any, _flags: Any, reason_code: Any, _properties: Any) -> None:
        if reason_code != 0:
            LOG.error("AWS IoT connection refused: %s", reason_code)
            return
        self.connected = True
        gateway_topic = (
            f"{self.settings.mqtt_topic_prefix}/"
            f"{self.settings.mqtt_site_id}/{self.settings.mqtt_gateway_id}"
        )
        client.subscribe(f"{gateway_topic}/telemetry", qos=1)
        client.subscribe(f"{gateway_topic}/alerts", qos=1)
        LOG.info("Subscribed to AWS IoT telemetry and alerts")

    def _on_disconnect(self, _client: mqtt.Client, _userdata: Any, _disconnect_flags: Any, reason_code: Any, _properties: Any) -> None:
        self.connected = False
        LOG.warning("AWS IoT disconnected: %s", reason_code)

    def _on_message(self, _client: mqtt.Client, _userdata: Any, message: mqtt.MQTTMessage) -> None:
        try:
            payload = json.loads(message.payload.decode("utf-8"))
            topic = message.topic
            if topic.endswith("/telemetry"):
                event = self._store_telemetry(payload)
            elif topic.endswith("/alerts"):
                event = self._store_alert(payload)
            else:
                return
            asyncio.run_coroutine_threadsafe(self.websocket_manager.broadcast(event), self.event_loop)
        except Exception:
            LOG.exception("Failed to handle MQTT message on %s", message.topic)

    def _store_telemetry(self, payload: dict[str, Any]) -> dict[str, Any]:
        device_id = str(payload["device_id"])
        gateway_id = str(payload["gateway_id"])
        raw_time = payload.get("timestamp")
        measured_at = datetime.fromisoformat(raw_time.replace("Z", "+00:00")) if raw_time else datetime.now(UTC)
        if measured_at.tzinfo is None:
            measured_at = measured_at.replace(tzinfo=UTC)
        values = payload.get("values")
        if not isinstance(values, dict):
            raise ValueError("Telemetry values must be an object")
        actuators = payload.get("actuators", {})
        if not isinstance(actuators, dict):
            raise ValueError("Telemetry actuators must be an object")
        with SessionLocal() as db:
            device = db.get(Device, device_id)
            if device is None:
                device = Device(id=device_id, gateway_id=gateway_id, name=device_id, kind="stm32")
                db.add(device)
            device.gateway_id = gateway_id
            device.is_online = True
            device.last_seen_at = measured_at
            if isinstance(actuators.get("fan"), bool):
                device.fan_state = actuators["fan"]
            if isinstance(actuators.get("light"), bool):
                device.light_state = actuators["light"]
            db.flush()
            readings = [
                {
                    "time": measured_at,
                    "device_id": device_id,
                    "sensor_type": str(sensor_type),
                    "value": float(value),
                }
                for sensor_type, value in values.items()
                if isinstance(value, (int, float)) and not isinstance(value, bool)
            ]
            if readings:
                db.execute(
                    pg_insert(SensorReading)
                    .values(readings)
                    .on_conflict_do_nothing(
                        index_elements=[
                            SensorReading.time,
                            SensorReading.device_id,
                            SensorReading.sensor_type,
                        ]
                    )
                )
            db.commit()
        return {"event": "telemetry", "data": payload}

    def _store_alert(self, payload: dict[str, Any]) -> dict[str, Any]:
        with SessionLocal() as db:
            alert = Alert(
                device_id=payload.get("device_id"),
                alert_type=str(payload.get("type", "unknown")),
                severity=str(payload.get("severity", "warning")),
                message=str(payload.get("message", "Alert received from gateway")),
            )
            db.add(alert)
            db.commit()
            db.refresh(alert)
            event = {
                "event": "alert",
                "data": {"id": alert.id, "device_id": alert.device_id, "type": alert.alert_type,
                         "severity": alert.severity, "message": alert.message, "created_at": alert.created_at.isoformat()},
            }
        return event

    def publish_command(self, device: Device, command: dict[str, Any]) -> bool:
        if not self.client or not self.connected:
            return False
        payload = {**command, "device_id": device.id, "timestamp": datetime.now(UTC).isoformat(), "source": "cloud_api"}
        topic = f"{self.settings.mqtt_topic_prefix}/{self.settings.mqtt_site_id}/{device.gateway_id}/command"
        result = self.client.publish(topic, json.dumps(payload), qos=1)
        return result.rc == mqtt.MQTT_ERR_SUCCESS
