from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "Smart Home API"
    database_url: str
    jwt_secret: str = Field(min_length=32)
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 30
    refresh_token_days: int = 14
    mqtt_enabled: bool = False
    aws_iot_endpoint: str = ""
    aws_iot_port: int = 8883
    aws_iot_ca_file: str = ""
    aws_iot_cert_file: str = ""
    aws_iot_key_file: str = ""
    mqtt_topic_prefix: str = "smarthome"
    mqtt_site_id: str = "home-01"
    mqtt_gateway_id: str = "pi-gateway-01"
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173"
    bootstrap_admin_email: str = ""
    bootstrap_admin_password: str = ""
    device_offline_timeout_seconds: int = Field(default=60, gt=0)

    @field_validator("jwt_secret")
    @classmethod
    def reject_placeholder_jwt_secret(cls, value: str) -> str:
        if any(marker in value.lower() for marker in ("replace", "change-me", "generate")):
            raise ValueError("JWT_SECRET must be replaced with a randomly generated secret")
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
