"""Collect Modbus telemetry and execute MQTT commands on one RS485 master."""
from __future__ import annotations

import json
import logging
import os
import queue
import signal
import sqlite3
import statistics
import threading
import uuid
from collections import defaultdict
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import paho.mqtt.client as mqtt
from pymodbus.client import ModbusSerialClient
from pymodbus.exceptions import ModbusException

LOG = logging.getLogger("serial_to_mqtt")

SERIAL_PORT = os.getenv("RS485_PORT", "/dev/ttyUSB0")
BAUDRATE = int(os.getenv("RS485_BAUDRATE", "9600"))
SLAVE_ID = int(os.getenv("MODBUS_SLAVE_ID", "1"))
POLL_SECONDS = float(os.getenv("POLL_SECONDS", "2"))
SAMPLES_PER_AGGREGATE = 10
MQTT_HOST = os.getenv("LOCAL_MQTT_HOST", "127.0.0.1")
MQTT_PORT = int(os.getenv("LOCAL_MQTT_PORT", "1883"))
MQTT_USERNAME = os.getenv("LOCAL_MQTT_USERNAME", "")
MQTT_PASSWORD = os.getenv("LOCAL_MQTT_PASSWORD", "")
SITE_ID = os.getenv("SITE_ID", "home-01")
GATEWAY_ID = os.getenv("GATEWAY_ID", "pi-gateway-01")
DEVICE_ID = os.getenv("DEVICE_ID", "stm32-01")
TOPIC = f"smarthome/{SITE_ID}/{GATEWAY_ID}/telemetry"
COMMAND_TOPIC = f"local/{SITE_ID}/{GATEWAY_ID}/command"
OUTBOX_PATH = Path(os.getenv(
    "GATEWAY_OUTBOX_PATH",
    str(Path(__file__).resolve().parent / "data" / "telemetry-outbox.sqlite3"),
))

REGISTER_MAP: dict[str, tuple[int, float]] = {
    "temperature": (0, 0.1),
    "humidity": (1, 0.1),
    "light": (2, 1.0),
    "motion": (3, 1.0),
}
COIL_MAP = {"fan": 0, "light": 1}


class TelemetryOutbox:
    """Small durable FIFO so telemetry survives gateway/broker interruptions."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        with closing(self._connect()) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=FULL")
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS telemetry_outbox (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    topic TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS pending_samples (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sample_json TEXT NOT NULL
                )
                """
            )
            db.commit()

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=10)
        db.execute("PRAGMA synchronous=FULL")
        return db

    def load_samples(self) -> list[dict[str, float]]:
        with closing(self._connect()) as db:
            rows = db.execute(
                "SELECT sample_json FROM pending_samples ORDER BY id"
            ).fetchall()
        return [json.loads(row[0]) for row in rows]

    def save_sample(self, sample: dict[str, float]) -> None:
        with closing(self._connect()) as db:
            with db:
                db.execute(
                    "INSERT INTO pending_samples (sample_json) VALUES (?)",
                    (json.dumps(sample, separators=(",", ":")),),
                )

    def enqueue_batch(self, topic: str, payload: str) -> None:
        with closing(self._connect()) as db:
            with db:
                db.execute(
                    "INSERT INTO telemetry_outbox (topic, payload, created_at) VALUES (?, ?, ?)",
                    (topic, payload, datetime.now(UTC).isoformat()),
                )
                db.execute("DELETE FROM pending_samples")

    def enqueue_event(self, topic: str, payload: str) -> None:
        with closing(self._connect()) as db:
            with db:
                db.execute(
                    "INSERT INTO telemetry_outbox (topic, payload, created_at) VALUES (?, ?, ?)",
                    (topic, payload, datetime.now(UTC).isoformat()),
                )

    def oldest(self) -> tuple[int, str, str] | None:
        with closing(self._connect()) as db:
            row = db.execute(
                "SELECT id, topic, payload FROM telemetry_outbox ORDER BY id LIMIT 1"
            ).fetchone()
        return row

    def delete(self, message_id: int) -> None:
        with closing(self._connect()) as db:
            with db:
                db.execute("DELETE FROM telemetry_outbox WHERE id = ?", (message_id,))


class GatewayCollector:
    def __init__(self) -> None:
        if not MQTT_USERNAME or not MQTT_PASSWORD:
            raise ValueError("LOCAL_MQTT_USERNAME and LOCAL_MQTT_PASSWORD must be configured")

        self.running = True
        self.stop_event = threading.Event()
        self.commands: queue.Queue[dict[str, str]] = queue.Queue(maxsize=100)
        self.outbox = TelemetryOutbox(OUTBOX_PATH)
        self.samples = self.outbox.load_samples()
        self.actuator_states: dict[str, bool] = {}
        self.modbus = ModbusSerialClient(
            port=SERIAL_PORT,
            baudrate=BAUDRATE,
            parity="N",
            stopbits=1,
            bytesize=8,
            timeout=1,
        )
        self.mqtt = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id=f"{GATEWAY_ID}-collector",
            clean_session=False,
        )
        self.mqtt.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)
        self.mqtt.reconnect_delay_set(min_delay=1, max_delay=60)
        self.mqtt.on_connect = self._on_mqtt_connect
        self.mqtt.on_disconnect = self._on_mqtt_disconnect
        self.mqtt.on_message = self._on_mqtt_message

    def _on_mqtt_connect(
        self,
        client: mqtt.Client,
        _userdata: Any,
        _flags: Any,
        reason_code: Any,
        _properties: Any,
    ) -> None:
        if reason_code != 0:
            LOG.error("Local Mosquitto connection refused: %s", reason_code)
            return
        result, _message_id = client.subscribe(COMMAND_TOPIC, qos=1)
        if result != mqtt.MQTT_ERR_SUCCESS:
            LOG.error("Could not subscribe to command topic %s, rc=%s", COMMAND_TOPIC, result)
            return
        LOG.info("Connected to local Mosquitto; subscribed to %s", COMMAND_TOPIC)

    def _on_mqtt_disconnect(
        self,
        _client: mqtt.Client,
        _userdata: Any,
        _disconnect_flags: Any,
        reason_code: Any,
        _properties: Any,
    ) -> None:
        LOG.warning("Disconnected from local Mosquitto: %s", reason_code)

    def _on_mqtt_message(
        self,
        _client: mqtt.Client,
        _userdata: Any,
        message: mqtt.MQTTMessage,
    ) -> None:
        try:
            if message.topic != COMMAND_TOPIC:
                LOG.warning("Ignoring command on unexpected topic %s", message.topic)
                return
            payload = json.loads(message.payload.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("Command payload must be a JSON object")
            action = payload.get("action")
            target = payload.get("target")
            if (
                not isinstance(action, str)
                or action not in {"turn_on", "turn_off"}
                or not isinstance(target, str)
                or target not in COIL_MAP
            ):
                raise ValueError("Unsupported command action or target")
            device_id = payload.get("device_id")
            if device_id is not None and device_id != DEVICE_ID:
                LOG.warning("Ignoring command for another device: %s", device_id)
                return
            self.commands.put_nowait({"action": action, "target": target})
        except queue.Full:
            LOG.error("Command queue is full; command on %s was rejected", message.topic)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            LOG.warning("Ignoring invalid command on %s: %s", message.topic, exc)

    def read_sample(self) -> dict[str, float] | None:
        response = self.modbus.read_input_registers(
            address=0, count=len(REGISTER_MAP), device_id=SLAVE_ID
        )
        if response.isError():
            LOG.warning("Modbus read failed: %s", response)
            return None
        if len(response.registers) != len(REGISTER_MAP):
            LOG.warning("Modbus returned %s registers; expected %s", len(response.registers), len(REGISTER_MAP))
            return None

        sample: dict[str, float] = {}
        for sensor_type, (register, scale) in REGISTER_MAP.items():
            raw = response.registers[register]
            if sensor_type == "temperature" and raw >= 0x8000:
                raw -= 0x10000
            sample[sensor_type] = raw * scale
        return sample

    def read_actuator_states(self) -> dict[str, bool] | None:
        response = self.modbus.read_coils(address=0, count=len(COIL_MAP), device_id=SLAVE_ID)
        if response.isError():
            LOG.warning("Modbus coil read failed: %s", response)
            return None
        if len(response.bits) < len(COIL_MAP):
            LOG.warning("Modbus returned %s coils; expected %s", len(response.bits), len(COIL_MAP))
            return None
        return {target: bool(response.bits[address]) for target, address in COIL_MAP.items()}

    def publish_actuator_states(self, states: dict[str, bool]) -> bool:
        payload = {
            "message_id": str(uuid.uuid4()),
            "site_id": SITE_ID,
            "gateway_id": GATEWAY_ID,
            "device_id": DEVICE_ID,
            "timestamp": datetime.now(UTC).isoformat(),
            "values": {},
            "actuators": states,
        }
        try:
            self.outbox.enqueue_event(TOPIC, json.dumps(payload, separators=(",", ":")))
        except sqlite3.Error:
            LOG.exception("Could not persist actuator state; it will be retried on the next poll")
            return False
        LOG.info("Queued confirmed actuator states for %s: %s", DEVICE_ID, states)
        return True

    def publish_average(self) -> None:
        buckets: dict[str, list[float]] = defaultdict(list)
        for sample in self.samples:
            for sensor_type, value in sample.items():
                buckets[sensor_type].append(value)
        averages = {
            key: round(statistics.fmean(values), 2)
            for key, values in buckets.items()
        }
        payload = {
            "message_id": str(uuid.uuid4()),
            "site_id": SITE_ID,
            "gateway_id": GATEWAY_ID,
            "device_id": DEVICE_ID,
            "timestamp": datetime.now(UTC).isoformat(),
            "sample_count": len(self.samples),
            "values": averages,
            "actuators": self.actuator_states,
        }
        sample_count = len(self.samples)
        try:
            self.outbox.enqueue_batch(TOPIC, json.dumps(payload, separators=(",", ":")))
        except sqlite3.Error:
            LOG.exception("Could not persist telemetry; keeping the batch in memory")
            return
        self.samples.clear()
        LOG.info("Persisted %s-sample average for %s", sample_count, TOPIC)

    def flush_outbox(self) -> None:
        if not self.mqtt.is_connected():
            return
        while self.mqtt.is_connected():
            entry = self.outbox.oldest()
            if entry is None:
                return
            message_id, topic, payload = entry
            result = self.mqtt.publish(topic, payload, qos=1)
            if result.rc != mqtt.MQTT_ERR_SUCCESS:
                LOG.warning("Telemetry publish could not be queued, rc=%s", result.rc)
                return
            try:
                result.wait_for_publish(timeout=2)
            except (RuntimeError, ValueError):
                LOG.exception("Waiting for telemetry PUBACK failed")
                return
            if not result.is_published():
                LOG.warning("No PUBACK for telemetry outbox item %s; will retry", message_id)
                return
            try:
                self.outbox.delete(message_id)
            except sqlite3.Error:
                LOG.exception("PUBACK received but could not remove outbox item %s", message_id)
                return
            LOG.info("Broker acknowledged telemetry outbox item %s", message_id)

    def handle_command(self, command: dict[str, str]) -> None:
        address = COIL_MAP[command["target"]]
        value = command["action"] == "turn_on"
        response = self.modbus.write_coil(
            address=address,
            value=value,
            device_id=SLAVE_ID,
        )
        if response.isError():
            LOG.error("Modbus command failed for %s: %s", command["target"], response)
            return
        LOG.info("Executed %s for %s on Modbus coil %s", command["action"], command["target"], address)
        states = self.read_actuator_states()
        if states is None:
            LOG.error("Could not confirm actuator state after command for %s", command["target"])
            return
        if self.publish_actuator_states(states):
            self.actuator_states = states

    def run(self) -> None:
        self.mqtt.connect_async(MQTT_HOST, MQTT_PORT, keepalive=60)
        self.mqtt.loop_start()
        try:
            while self.running:
                try:
                    self.flush_outbox()
                except sqlite3.Error:
                    LOG.exception("Telemetry outbox database operation failed")
                try:
                    if not self.modbus.connected and not self.modbus.connect():
                        LOG.warning("Cannot connect to Modbus RTU at %s", SERIAL_PORT)
                        self.stop_event.wait(POLL_SECONDS)
                        continue
                    actual_states = self.read_actuator_states()
                    if actual_states is not None and actual_states != self.actuator_states:
                        if self.publish_actuator_states(actual_states):
                            self.actuator_states = actual_states
                    try:
                        command = self.commands.get_nowait()
                    except queue.Empty:
                        command = None
                    if command is not None:
                        self.handle_command(command)
                    elif len(self.samples) >= SAMPLES_PER_AGGREGATE:
                        self.publish_average()
                    else:
                        sample = self.read_sample()
                        if sample is not None:
                            self.outbox.save_sample(sample)
                            self.samples.append(sample)
                            if len(self.samples) >= SAMPLES_PER_AGGREGATE:
                                self.publish_average()
                except (OSError, RuntimeError, ModbusException) as exc:
                    LOG.exception("Gateway I/O operation failed: %s", exc)
                    self.modbus.close()
                except sqlite3.Error:
                    LOG.exception("Could not persist sampled telemetry")
                self.stop_event.wait(POLL_SECONDS)
        finally:
            self.modbus.close()
            self.mqtt.disconnect()
            self.mqtt.loop_stop()

    def stop(self) -> None:
        self.running = False
        self.stop_event.set()


def main() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    collector = GatewayCollector()
    signal.signal(signal.SIGINT, lambda *_: collector.stop())
    signal.signal(signal.SIGTERM, lambda *_: collector.stop())
    collector.run()


if __name__ == "__main__":
    main()
