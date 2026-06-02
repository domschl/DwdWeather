import json
import os
from pathlib import Path
from pydantic import BaseModel

class AppConfig(BaseModel):
    station_id: str = "10865"
    cache_expiry_secs: int = 3600
    port: int = 8089
    host: str = "0.0.0.0"

def load_config() -> AppConfig:
    # 1. Start with defaults
    config = AppConfig()

    # 2. Check if a local config.json exists
    config_path = Path("config.json")
    if config_path.is_file():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
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
        except Exception as e:
            print(f"Warning: Failed to load config.json: {e}")

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

    # 4. Enforce cache_expiry hard limit: at least 1800 seconds
    if config.cache_expiry_secs < 1800:
        config.cache_expiry_secs = 1800

    return config
