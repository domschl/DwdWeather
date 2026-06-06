import logging
import os
import time
import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, status
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from dwd_server.config import load_config, AppConfig
from dwd_server.parser import fetch_and_parse, WeatherForecast
from dwd_server.mqtt_client import MQTTManager

# Set up logging
logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
    level=logging.INFO
)
logger = logging.getLogger("dwd_server.main")

config:AppConfig = load_config()

# Cache structures
CACHE_DIR = Path(config.cache_dir)
CACHE_FILE = CACHE_DIR / "weather_cache.json"

mqtt_manager: MQTTManager | None = None
mqtt_manager_indoor: MQTTManager | None = None
if config.mqtt_host:
    mqtt_manager = MQTTManager(
        host=config.mqtt_host,
        port=config.mqtt_port,
        topic=config.mqtt_topic,
        cache_dir=CACHE_DIR,
        history_filename="mqtt_history.json"
    )
    if config.mqtt_topic_indoor:
        mqtt_manager_indoor = MQTTManager(
            host=config.mqtt_host,
            port=config.mqtt_port,
            topic=config.mqtt_topic_indoor,
            cache_dir=CACHE_DIR,
            history_filename="mqtt_history_indoor.json"
        )

app = FastAPI(
    title="Modern DWD Weather Hub",
    description="Streamlined and modernized German Weather Service (DWD) forecast server",
    version="1.0.0"
)

# Enable CORS for development ease
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class CacheEntry:
    def __init__(self, last_updated: float, forecast: WeatherForecast) -> None:
        self.last_updated = last_updated
        self.forecast = forecast

_memory_cache: CacheEntry | None = None

def ensure_cache_dir() -> None:
    if not CACHE_DIR.exists():
        CACHE_DIR.mkdir(parents=True, exist_ok=True)

def load_cache_from_disk() -> CacheEntry | None:
    global _memory_cache
    if _memory_cache is not None:
        return _memory_cache

    if not CACHE_FILE.is_file():
        return None

    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            last_updated = float(data.get("last_updated", 0.0))
            forecast_data = data.get("forecast")
            if forecast_data:
                forecast = WeatherForecast(**forecast_data)
                _memory_cache = CacheEntry(last_updated, forecast)
                return _memory_cache
    except Exception as e:
        logger.warning(f"Failed to read cache file from disk: {e}")
    return None

def write_cache_to_disk(forecast: WeatherForecast) -> None:
    global _memory_cache
    ensure_cache_dir()
    last_updated = time.time()
    _memory_cache = CacheEntry(last_updated, forecast)
    try:
        data = {
            "last_updated": last_updated,
            "forecast": forecast.model_dump()
        }
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        logger.info(f"Cached forecast for station {forecast.station_id} written to disk.")
    except Exception as e:
        logger.error(f"Failed to write cache to disk: {e}")

def update_forecast_on_demand() -> WeatherForecast:
    """Attempts to fetch from DWD. If successful, caches and returns it. If fails, returns expired cache or raises error."""
    cache = load_cache_from_disk()
    station_id = config.station_id

    # Attempt fetch
    logger.info(f"On-demand refresh triggered for station {station_id}")
    new_forecast = fetch_and_parse(station_id)

    if new_forecast is not None:
        write_cache_to_disk(new_forecast)
        return new_forecast
    
    # Fallback to cache if DWD request failed
    if cache is not None:
        logger.warning(f"DWD fetch failed; falling back to stale cache from {time.ctime(cache.last_updated)}")
        return cache.forecast

    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Failed to retrieve weather data from DWD and no cached data is available."
    )

def get_forecast_data(force_refresh: bool = False) -> dict[str, Any]:
    cache = load_cache_from_disk()
    now = time.time()

    # Enforce minimum hard limit of 1800s between fetches
    min_rate_limit = 1800
    is_rate_limited = False

    if cache is not None:
        elapsed = now - cache.last_updated
        if elapsed < min_rate_limit:
            is_rate_limited = True

    # Check if we should update
    should_update = force_refresh
    if not should_update:
        if cache is None:
            should_update = True
        else:
            elapsed = now - cache.last_updated
            if elapsed >= config.cache_expiry_secs:
                should_update = True

    if should_update:
        if is_rate_limited:
            logger.info("DWD update requested but rate-limited (last update was less than 1800 seconds ago). Serving from cache.")
            result_forecast = cache.forecast  # type: ignore
            source = "cache (rate-limited)"
            last_updated = cache.last_updated  # type: ignore
        else:
            result_forecast = update_forecast_on_demand()
            source = "network"
            # Refresh memory cache, load again to get the exact last_updated time
            refreshed_cache = load_cache_from_disk()
            last_updated = refreshed_cache.last_updated if refreshed_cache else now
    else:
        result_forecast = cache.forecast  # type: ignore
        source = "cache"
        last_updated = cache.last_updated  # type: ignore

    mqtt_data = mqtt_manager.get_data() if mqtt_manager else {"last_measurement": None, "history": {}}
    mqtt_indoor_data = mqtt_manager_indoor.get_data() if mqtt_manager_indoor else {"last_measurement": None, "history": {}}
    return {
        "source": source,
        "last_updated": last_updated,
        "next_allowed_update": last_updated + min_rate_limit,
        "cache_expiry_secs": config.cache_expiry_secs,
        "forecast": result_forecast,
        "mqtt_last_measurement": mqtt_data.get("last_measurement"),
        "mqtt_history": mqtt_data.get("history"),
        "mqtt_indoor_last_measurement": mqtt_indoor_data.get("last_measurement"),
        "mqtt_indoor_history": mqtt_indoor_data.get("history")
    }

@app.get("/api/forecast")
def get_forecast() -> dict[str, Any]:
    return get_forecast_data(force_refresh=False)

@app.post("/api/refresh")
def refresh_forecast() -> dict[str, Any]:
    return get_forecast_data(force_refresh=True)

@app.get("/api/config")
def get_current_config() -> dict[str, Any]:
    return {
        "station_id": config.station_id,
        "cache_expiry_secs": config.cache_expiry_secs,
        "min_cache_expiry_limit": 1800,
        "port": config.port,
        "host": config.host
    }

# Ensure static files directory exists before mounting
static_dir = Path(__file__).parent / "static"
if not static_dir.exists():
    static_dir.mkdir(parents=True, exist_ok=True)

app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")

def run() -> None:
    # Ensure cache directory is ready on startup
    ensure_cache_dir()
    
    if mqtt_manager:
        mqtt_manager.start()
    if mqtt_manager_indoor:
        mqtt_manager_indoor.start()

    logger.info(f"Starting server with station_id={config.station_id}, cache_expiry_secs={config.cache_expiry_secs}s")
    uvicorn.run("dwd_server.main:app", host=config.host, port=config.port, reload=False)

if __name__ == "__main__":
    run()
