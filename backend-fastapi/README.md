# Smart Home FastAPI backend

Run the cloud backend and TimescaleDB from this folder:

```powershell
Copy-Item .env.example .env
# Replace all placeholders; POSTGRES_PASSWORD must match DATABASE_URL.
docker compose up --build
```

The API docs are available at `http://localhost:8000/docs` and the health
probe at `http://localhost:8000/health`.

Generate independent secrets before deployment, for example with
`python -c "import secrets; print(secrets.token_hex(32))"`. Compose requires a
database URL, database user/password, and a JWT secret of at least 32
characters; it will not fall back to development credentials. PostgreSQL is
bound to `127.0.0.1:5432` for local DBeaver access and is not exposed on the
LAN.

For development, the API container mounts `certs/` at `/run/secrets/aws`.
Keep the backend's AWS IoT certificate and key (`certificate.pem.crt` and
`private.pem.key`) here with `AmazonRootCA1.pem`. Do not put the Mosquitto
bridge private key in this directory. Attach a policy to the backend
certificate that allows client ID `smarthome-fastapi` to connect, receive
telemetry/alerts, and publish commands, then set `MQTT_ENABLED=true`. Set
`MQTT_SITE_ID` and `MQTT_GATEWAY_ID` to the gateway whose telemetry/alerts the
backend subscribes to. Complete the `AWS_IOT_*` values in `.env`. Replace
`JWT_SECRET` and use a bootstrap admin password only for first deployment.
The bootstrap account is configured by `BOOTSTRAP_ADMIN_EMAIL` and
`BOOTSTRAP_ADMIN_PASSWORD`.

For the backend certificate, attach a policy like this (replace the account,
region, site, or gateway values if yours differ):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "iot:Connect",
      "Resource": "arn:aws:iot:ap-southeast-1:349412601177:client/smarthome-fastapi"
    },
    {
      "Effect": "Allow",
      "Action": "iot:Subscribe",
      "Resource": [
        "arn:aws:iot:ap-southeast-1:349412601177:topicfilter/smarthome/home-01/pi-gateway-01/telemetry",
        "arn:aws:iot:ap-southeast-1:349412601177:topicfilter/smarthome/home-01/pi-gateway-01/alerts"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "iot:Receive",
      "Resource": [
        "arn:aws:iot:ap-southeast-1:349412601177:topic/smarthome/home-01/pi-gateway-01/telemetry",
        "arn:aws:iot:ap-southeast-1:349412601177:topic/smarthome/home-01/pi-gateway-01/alerts"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "iot:Publish",
      "Resource": "arn:aws:iot:ap-southeast-1:349412601177:topic/smarthome/home-01/pi-gateway-01/command"
    }
  ]
}
```

To bootstrap an administrator on first startup, set both
`BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` to deployment-specific
values in `.env`; no default user is created when they are blank.

`POST /api/v1/auth/login` uses standard OAuth2 form data: send the email in
the `username` field and the password in the `password` field. WebSocket
clients connect to `/ws/telemetry?token=<access_token>`.

`Base.metadata.create_all()` creates missing tables at API startup. Startup
also ensures the `sensor_readings.id` sequence and the
`(time, device_id, sensor_type)` unique index used to deduplicate QoS 1
redeliveries. Existing duplicate rows for the same device, sensor type, and
timestamp must be reconciled before that index can be created. `create_all()`
does not migrate other model changes; use a database migration for those.
