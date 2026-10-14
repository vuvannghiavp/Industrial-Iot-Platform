# Raspberry Pi gateway

## Modbus ownership

`serial_to_mqtt.py` is the only Modbus RTU master. Node-RED must not use a
Modbus node or open `/dev/ttyUSB0`; it sends validated commands to MQTT and
the gateway executes them on its Modbus connection.

Telemetry is averaged over ten successful samples and published at QoS 1 to
`smarthome/<SITE_ID>/<GATEWAY_ID>/telemetry`. A SQLite outbox retains each
successful sample and aggregate on disk. Ten pending samples are converted
to one outbox message atomically; that aggregate remains until the local
broker acknowledges its QoS 1 publish. Set `GATEWAY_OUTBOX_PATH` to a
persistent, writable filesystem location.

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
file at `/etc/mosquitto/passwd` with three users: `gateway`, `node_red`, and
`aws_bridge`. Set the `aws_bridge` password to the same strong value as
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
the ACL at `/etc/mosquitto/acl`; install `mosquitto.acl` at that path.

Set `LOCAL_MQTT_USERNAME=gateway` and the matching password in the gateway
process environment. In the Node-RED editor, set username `node_red` and its
password on the `Local Mosquitto` broker configuration node; Node-RED stores
credentials separately from `flows.json`.

The flow's broker address and the listener are restricted to `127.0.0.1`.
If Node-RED runs in a container, it needs an explicitly configured reachable
listener address and broker address; keep authentication and ACLs enabled,
and restrict the listener to the trusted container network.

The example bridge is restricted to site `home-01` and gateway
`pi-gateway-01`. Its AWS MQTT client ID is `pi-gateway-01`; keep that in sync
with the certificate policy's `iot:Connect` client ARN. The bridge publishes
only telemetry and alerts to AWS and subscribes only to that gateway's command
topic. AWS commands arrive locally on `smarthome/home-01/pi-gateway-01/command`;
Node-RED validates them and forwards them to
`local/home-01/pi-gateway-01/command`, which the gateway consumes. Internal
commands on `local/...` are not bridged back to AWS.

The attached AWS IoT policy should grant `iot:Publish` only for the telemetry
and alerts topics, and `iot:Subscribe`/`iot:Receive` only for the command
topic/topic filter. If `SITE_ID` or `GATEWAY_ID` changes in the gateway
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
