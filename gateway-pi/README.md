# Raspberry Pi gateway

## Modbus ownership

`serial_to_mqtt.py` is the only Modbus RTU master. Node-RED must not use a
Modbus node or open `/dev/ttyUSB0`; it sends validated commands to MQTT and
the gateway executes them on its Modbus connection.

Telemetry is averaged over ten successful samples and published at QoS 1 to
`home/v1/<USER_ID>/<ROOM_ID>/<DEVICE_ID>/telemetry/<sensor_id>/<measurement>`
for local consumers. The gateway also publishes the existing aggregate to
`smarthome/<SITE_ID>/<GATEWAY_ID>/telemetry` so the current AWS bridge and
FastAPI consumer keep working during migration. A SQLite outbox retains each
successful sample and aggregate on disk. Ten pending samples are converted
to one outbox message atomically; that aggregate remains until the local
broker acknowledges its QoS 1 publish. Set `GATEWAY_OUTBOX_PATH` to a
persistent, writable filesystem location.

Configure `USER_ID` to the home owner's numeric backend user ID, `ROOM_ID` to
the MCU's room, and `DEVICE_ID` to a unique name you assign that MCU (for
example, `esp32-bedroom-01`). Each MCU in another room gets its own
`ROOM_ID` and `DEVICE_ID`. The MQTT username is the same as `USER_ID`; the
Mosquitto ACL uses that username to scope `home/v1` access to the owner's
topics. Give each MCU and gateway for that owner the same local broker
credentials.

The gateway reads the fan and light output coils from Modbus every poll.
Changed states and successful command writes are immediately queued to the
same telemetry topic in the `actuators` object; regular sensor aggregates also
include both current coil states. FastAPI stores these states on the device
record and broadcasts them to the dashboard over WebSocket. The dashboard
therefore follows Node-RED automatic commands as well as commands sent from
the UI, without treating MQTT publish acceptance as hardware confirmation.

The Node-RED temperature rule turns the fan on above 33°C and off below 25°C.
Sensor telemetry is averaged across ten successful reads (about 20 seconds at
the default two-second poll interval), so the rule evaluates each published
average rather than every raw sensor read. It publishes a command only when
the fan needs to change state; the subsequent Modbus coil report is what
updates the device state in PostgreSQL and the dashboard.

## Local broker security

The Mosquitto configuration denies anonymous clients and applies
`mosquitto.acl`. Copy that ACL to `/etc/mosquitto/acl` and create the password
file at `/etc/mosquitto/passwd` with users for each home owner (the MQTT
username equals the backend `USER_ID`), `node_red`, and `aws_bridge`. Set the owner's
password to the value provisioned on the ESP32 and gateway. Set the
`aws_bridge` password to the same strong value as
`local_password` in `mosquitto.conf`; replace its placeholder and restrict
the config file permissions because Mosquitto bridge credentials are stored
there in plaintext. Replace the placeholder in the deployed, protected copy
of the config, not in a version-controlled source file. Keep AWS certificates
readable only by the Mosquitto service account. The bridge uses its own AWS
IoT certificate at `/etc/mosquitto/certs/certificate.pem.crt` and key at
`/etc/mosquitto/certs/private.pem.key`, copied from this directory's `certs/`.
Keep the FastAPI certificate and private key in the separate
`backend-fastapi/certs/` directory; never reuse or copy the bridge private key
for the API. The public AWS root CA may be installed for each component
independently.

For example, create the password file using `mosquitto_passwd -c` for the
first user and `mosquitto_passwd` for each additional user. Do not commit the
generated password file or real credentials. The main configuration expects
the ACL at `/etc/mosquitto/acl`; install `mosquitto.acl` at that path. Add a
`user <USER_ID>` section for every owner that also lists the existing legacy
AWS telemetry permission; the `%u` ACL patterns already scope new local
topics to each owner's matching user ID.

Set `USER_ID` and `LOCAL_MQTT_PASSWORD` in the gateway process environment.
For Node-RED cloud commands and the legacy aggregate rule, set
`HOME_DEVICE_ROUTES` to a JSON object keyed by device ID, for example
`{"esp32-bedroom-01":{"user_id":"7","room_id":"bedroom"},"esp32-kitchen-01":{"user_id":"7","room_id":"kitchen"}}`.
The Node-RED service account can then route each command to the room and MCU
named in the mapping. In the Node-RED editor,
set username `node_red` and its password on the `Local Mosquitto` broker
configuration node; Node-RED stores credentials separately from `flows.json`.

In ESP-IDF `menuconfig`, set `HOME_USER_ID` to the backend account's numeric
ID, `HOME_ROOM_ID` to the room containing this MCU, and `HOME_DEVICE_ID` to
the unique MCU name. Then set `HOME_MQTT_BROKER_URI` to
`mqtt://<PI_LAN_IP>:1883` and enter the owner's Mosquitto password in
`HOME_MQTT_PASSWORD`. ESP32 connects to the Pi over plain MQTT without TLS
or client certificates, using `HOME_USER_ID` as its MQTT username and the
password for authentication. Its broker URI is checked to require `mqtt://`.
Sensor IDs can be set separately
for temperature, humidity, illuminance, and motion. Set all identity fields
and the broker URI before building/flashing; the identity defaults are empty.
Keep the generated `sdkconfig` local because it contains the broker password.
For the Modbus gateway, `TEMPERATURE_SENSOR_ID`, `HUMIDITY_SENSOR_ID`,
`ILLUMINANCE_SENSOR_ID`, and `MOTION_SENSOR_ID` in `.env` set its sensor IDs.

The local listener accepts connections on the Pi's network interfaces so
MCUs can connect. Restrict port 1883 to the trusted home LAN with the host
firewall; keep authentication and ACLs enabled. If Node-RED runs in a
container, configure its broker address to a reachable Pi address.
This listener uses unencrypted MQTT on port 1883; do not expose it outside the
trusted LAN, and use TLS if the local network is not trusted.

The internal Pi topic format is
`home/v1/<USER_ID>/<ROOM_ID>/<DEVICE_ID>/<telemetry|command|state>/...`.
Sensor telemetry is split by sensor and measurement, for example
`home/v1/7/bedroom/esp32-bedroom-01/telemetry/dht22-01/temperature`.
Commands use one topic per target, for example
`home/v1/7/bedroom/esp32-bedroom-01/command/fan`, with
`{"action":"turn_on","target":"fan"}` as the payload. The gateway subscribes
only to its configured device's command topics. The ESP32 uses the same
`command/fan` path with `{"state":"ON"}` or `{"state":"OFF"}`; fan speed is
sent to `command/fan/speed`.

The example bridge is restricted to site `home-01` and gateway
`pi-gateway-01`. Its AWS MQTT client ID is `pi-gateway-01`; keep that in sync
with the certificate policy's `iot:Connect` client ARN. The bridge publishes
the legacy aggregate telemetry and alerts, plus the new `home/v1` telemetry,
state, and availability topics to AWS. Update the AWS IoT certificate policy
to allow publishing `home/v1/*/*/*/telemetry/*/*`,
`home/v1/*/*/*/state/*`, `home/v1/*/*/*/state/*/*`, and
`home/v1/*/*/*/availability` before enabling those mappings. The bridge
continues subscribing only to the legacy gateway command topic. AWS commands arrive locally on
`smarthome/home-01/pi-gateway-01/command`; Node-RED validates them and forwards
them to the matching `home/v1/<USER_ID>/<ROOM_ID>/<DEVICE_ID>/command/<target>`
topic. The new per-sensor topics are forwarded to AWS, but FastAPI currently
subscribes to and processes only the legacy aggregate. Update its MQTT
subscriptions and payload handling separately before relying on the new
topics in the backend; the legacy aggregate remains available meanwhile.

The AWS IoT policy should grant `iot:Publish` only for the legacy telemetry
and alerts topics plus the new telemetry, state, and availability topic
patterns, and `iot:Subscribe`/`iot:Receive` only for the legacy command topic
and filter. If `SITE_ID` or `GATEWAY_ID` changes in the gateway
environment, update the bridge topic mappings, local ACL, Node-RED flow, and
AWS policy together.

## Run

Install the packages in `requirements.txt`, configure the environment above,
install the Mosquitto config/ACL/certificates at the paths referenced by
`mosquitto.conf`, then run:

```sh
python serial_to_mqtt.py
```

Make sure the OS account running the gateway can access the RS485 device and
write to the outbox directory.

The persistence path in `mosquitto.conf` matches the official Mosquitto
container layout; mount `/mosquitto/data` to persistent storage. For a native
package installation, change it to that package's writable persistence
directory.
