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

## Local broker security

The Mosquitto configuration denies anonymous clients and applies
`mosquitto.acl`. Copy that ACL to `/etc/mosquitto/acl` and create the password
file at `/etc/mosquitto/passwd` with three users: `gateway`, `node_red`, and
`aws_bridge`. Set the `aws_bridge` password to the same strong value as
`local_password` in `mosquitto.conf`; replace its placeholder and restrict
the config file permissions because Mosquitto bridge credentials are stored
there in plaintext. Replace the placeholder in the deployed, protected copy
of the config, not in a version-controlled source file. Keep AWS certificates
readable only by the Mosquitto service account.

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

The bridge forwards telemetry and alerts only to AWS (`out`) and commands
only from AWS (`in`). Internal commands use `local/<site>/<gateway>/command`
and therefore are not bridged back to AWS. Ensure the AWS IoT policy allows
the bridge certificate to publish telemetry/alerts and subscribe/receive
commands on the corresponding `smarthome/...` topics.

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
