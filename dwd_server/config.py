import json
import os
from pathlib import Path
from pydantic import BaseModel

class AppConfig(BaseModel):
    station_id: str = "10865"
    cache_expiry_secs: int = 3600
    port: int = 8089
    host: str = "0.0.0.0"
    mqtt_host: str | None = "nalanda"
    mqtt_port: int = 1883
    mqtt_topic: str = "omu/enviro-master/BME280-1/sensor/temperature"
    mqtt_topic_indoor: str | None = "blegate/gator/wohnzimmer/sensor/temperature"
    mqtt_additional_topics: list[str] = [
        "omu/enviro-master/GEIGER-1/sensor/frequency",
        "omu/enviro-master/BME280-1/sensor/pressureNN",
        "omu/enviro-master/BME280-1/sensor/humidity",
        "omu/enviro-master/TSL2561-1/sensor/illuminance",
        "omu/enviro-master/MAGNETIC-1/sensor/magnetic_field_strength",
        "omu/enviro-master/MAGNETIC-1/sensor/magnetic_field_x",
        "omu/enviro-master/MAGNETIC-1/sensor/magnetic_field_y",
        "omu/enviro-master/MAGNETIC-1/sensor/magnetic_field_z",
        "omu/enviro-master/GAMMA-1/sensor/gamma10minavg",
        "omu/enviro-master/GAMMA-1/sensor/gamma1minavg",
        "omu/enviro-master/RAIN-1/sensor/unitrain"
    ]
    cache_dir: str = "cache"
    database_path: str = "cache/dwdweather.db"
    hiking_stations: list[dict[str, str]] = [
        {"station_id": "P966", "label": "Obere Firstalm / Schliersee"},
        {"station_id": "P965", "label": "Miesbach"},
        {"station_id": "P0159", "label": "Gmund / Tegernsee"},
    ]

def load_config() -> AppConfig:
    # 1. Start with defaults
    config = AppConfig()

    # 2. Check configuration file locations
    config_paths = [Path("/etc/dwdweather/config.json"), Path("config.json")]
    for path in config_paths:
        if path.is_file():
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    # Overwrite config values with json values
                    if "station_id" in data:
                        config.station_id = str(data["station_id"])
                    if "cache_expiry_secs" in data:
                        config.cache_expiry_secs = int(data["cache_expiry_secs"])
                    if "port" in data:
                        config.port = int(data["port"])
                    if "host" in data:
                        config.host = str(data["host"])
                    if "mqtt_host" in data:
                        # Allow setting empty/null to disable MQTT
                        config.mqtt_host = data["mqtt_host"] if data["mqtt_host"] else None
                    if "mqtt_port" in data:
                        config.mqtt_port = int(data["mqtt_port"])
                    if "mqtt_topic" in data:
                        config.mqtt_topic = str(data["mqtt_topic"])
                    if "mqtt_topic_indoor" in data:
                        config.mqtt_topic_indoor = data["mqtt_topic_indoor"] if data["mqtt_topic_indoor"] else None
                    if "mqtt_additional_topics" in data:
                        config.mqtt_additional_topics = [str(x) for x in data["mqtt_additional_topics"]]
                    if "cache_dir" in data:
                        config.cache_dir = str(data["cache_dir"])
                    if "database_path" in data:
                        config.database_path = str(data["database_path"])
                    if "hiking_stations" in data and isinstance(data["hiking_stations"], list):
                        parsed_hiking: list[dict[str, str]] = []
                        for item in data["hiking_stations"]:
                            if isinstance(item, dict) and item.get("station_id"):
                                parsed_hiking.append({
                                    "station_id": str(item["station_id"]).strip(),
                                    "label": str(item.get("label", "")).strip(),
                                })
                            elif isinstance(item, str) and item.strip():
                                parsed_hiking.append({"station_id": item.strip(), "label": ""})
                        if parsed_hiking:
                            config.hiking_stations = parsed_hiking
            except Exception as e:
                print(f"Warning: Failed to load config from {path}: {e}")

    # 3. Check environment variables (which take highest precedence)
    station_env = os.environ.get("DWD_STATION_ID")
    if station_env:
        config.station_id = station_env

    cache_env = os.environ.get("DWD_CACHE_EXPIRY_SECS")
    if cache_env:
        try:
            config.cache_expiry_secs = int(cache_env)
        except ValueError:
            pass

    port_env = os.environ.get("DWD_PORT")
    if port_env:
        try:
            config.port = int(port_env)
        except ValueError:
            pass

    host_env = os.environ.get("DWD_HOST")
    if host_env:
        config.host = host_env

    mqtt_host_env = os.environ.get("DWD_MQTT_HOST")
    if mqtt_host_env is not None:
        config.mqtt_host = mqtt_host_env if mqtt_host_env else None

    mqtt_port_env = os.environ.get("DWD_MQTT_PORT")
    if mqtt_port_env:
        try:
            config.mqtt_port = int(mqtt_port_env)
        except ValueError:
            pass

    mqtt_topic_env = os.environ.get("DWD_MQTT_TOPIC")
    if mqtt_topic_env:
        config.mqtt_topic = mqtt_topic_env

    mqtt_topic_indoor_env = os.environ.get("DWD_MQTT_TOPIC_INDOOR")
    if mqtt_topic_indoor_env is not None:
        config.mqtt_topic_indoor = mqtt_topic_indoor_env if mqtt_topic_indoor_env else None

    mqtt_additional_topics_env = os.environ.get("DWD_MQTT_ADDITIONAL_TOPICS")
    if mqtt_additional_topics_env:
        config.mqtt_additional_topics = [x.strip() for x in mqtt_additional_topics_env.split(",") if x.strip()]

    cache_dir_env = os.environ.get("DWD_CACHE_DIR")
    if cache_dir_env:
        config.cache_dir = cache_dir_env

    database_path_env = os.environ.get("DWD_DATABASE_PATH")
    if database_path_env:
        config.database_path = database_path_env

    # 4. Enforce cache_expiry hard limit: at least 1800 seconds
    if config.cache_expiry_secs < 1800:
        config.cache_expiry_secs = 1800

    return config
