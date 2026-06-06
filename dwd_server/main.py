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
from dwd_server.database import Database

# Set up logging
logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
    level=logging.INFO
)
logger = logging.getLogger("dwd_server.main")

config:AppConfig = load_config()

db = Database(config.database_path)

# Cache structures
CACHE_DIR = Path(config.cache_dir)
CACHE_FILE = CACHE_DIR / "weather_cache.json"

mqtt_manager: MQTTManager | None = None
mqtt_manager_indoor: MQTTManager | None = None
if config.mqtt_host:
    outdoor_topics = [config.mqtt_topic] + config.mqtt_additional_topics
    mqtt_manager = MQTTManager(
        host=config.mqtt_host,
        port=config.mqtt_port,
        topic=outdoor_topics,
        cache_dir=CACHE_DIR,
        history_filename="mqtt_history.json",
        db=db
    )
    if config.mqtt_topic_indoor:
        mqtt_manager_indoor = MQTTManager(
            host=config.mqtt_host,
            port=config.mqtt_port,
            topic=config.mqtt_topic_indoor,
            cache_dir=CACHE_DIR,
            history_filename="mqtt_history_indoor.json",
            db=db
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
        db.insert_forecast_readings(forecast.station_id, forecast.timesteps, forecast.elements)
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

last_sw_fetch_time = 0.0

def fetch_and_store_space_weather(database: Database) -> None:
    global last_sw_fetch_time
    import urllib.request
    from datetime import datetime
    
    now = time.time()
    if now - last_sw_fetch_time < 300:
        logger.info("Space weather fetch cooldown active, skipping polling.")
        return
        
    last_sw_fetch_time = now
    
    # 1. Fetch Planetary Kp Index
    try:
        logger.info("Polling NOAA Kp-index space weather data...")
        req = urllib.request.Request(
            "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json", 
            headers={'User-Agent': 'Mozilla/5.0 (DwdWeatherHub)'}
        )
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode('utf-8'))
            for item in data:
                time_tag = item.get("time_tag")
                kp_val = item.get("estimated_kp")
                if time_tag and kp_val is not None:
                    dt = datetime.fromisoformat(time_tag)
                    timestamp = dt.strftime("%Y-%m-%dT%H:%M:00.000Z")
                    database.insert_sensor_reading(timestamp, "noaa", "kp", float(kp_val))
        logger.info("Successfully populated NOAA Kp-index data in DB.")
    except Exception as e:
        logger.warning(f"Failed to fetch NOAA Kp-index: {e}")
        
    # 2. Fetch RTSW Solar Wind Plasma
    try:
        logger.info("Polling NOAA solar wind plasma data...")
        req = urllib.request.Request(
            "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json", 
            headers={'User-Agent': 'Mozilla/5.0 (DwdWeatherHub)'}
        )
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode('utf-8'))
            for item in data:
                time_tag = item.get("time_tag")
                speed = item.get("proton_speed")
                density = item.get("proton_density")
                if time_tag:
                    dt = datetime.fromisoformat(time_tag)
                    timestamp = dt.strftime("%Y-%m-%dT%H:%M:00.000Z")
                    if speed is not None:
                        database.insert_sensor_reading(timestamp, "noaa", "wind_speed", float(speed))
                    if density is not None:
                        database.insert_sensor_reading(timestamp, "noaa", "wind_density", float(density))
        logger.info("Successfully populated NOAA solar wind plasma data in DB.")
    except Exception as e:
        logger.warning(f"Failed to fetch NOAA solar wind plasma: {e}")
        
    # 3. Fetch RTSW Solar Wind Magnetometer
    try:
        logger.info("Polling NOAA solar wind magnetometer data...")
        req = urllib.request.Request(
            "https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json", 
            headers={'User-Agent': 'Mozilla/5.0 (DwdWeatherHub)'}
        )
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode('utf-8'))
            for item in data:
                time_tag = item.get("time_tag")
                bt = item.get("bt")
                bz = item.get("bz_gsm")
                if time_tag:
                    dt = datetime.fromisoformat(time_tag)
                    timestamp = dt.strftime("%Y-%m-%dT%H:%M:00.000Z")
                    if bt is not None:
                        database.insert_sensor_reading(timestamp, "noaa", "imf_bt", float(bt))
                    if bz is not None:
                        database.insert_sensor_reading(timestamp, "noaa", "imf_bz", float(bz))
        logger.info("Successfully populated NOAA solar wind magnetometer data in DB.")
    except Exception as e:
        logger.warning(f"Failed to fetch NOAA solar wind magnetometer: {e}")

@app.get("/api/history")
def get_history(start: str, end: str) -> dict[str, Any]:
    # Poll space weather data on history request to keep it up to date
    fetch_and_store_space_weather(db)

    outdoor_history = []
    if config.mqtt_topic:
        outdoor_history = db.get_sensor_history(config.mqtt_topic, "temperature", start, end)
        
    indoor_history = []
    if config.mqtt_topic_indoor:
        indoor_history = db.get_sensor_history(config.mqtt_topic_indoor, "temperature", start, end)
        
    forecast_history = db.get_forecast_history(config.station_id, "TTT", start, end)
    forecast_wwp = db.get_forecast_history(config.station_id, "wwP", start, end)
    forecast_sund = db.get_forecast_history(config.station_id, "SunD1", start, end)
    
    # Query history for all additional sensors
    additional_history = {}
    for topic in config.mqtt_additional_topics:
        metric = topic.split('/')[-1]
        additional_history[topic] = db.get_sensor_history(topic, metric, start, end)
        
    kp_history = db.get_sensor_history("noaa", "kp", start, end)
    wind_speed = db.get_sensor_history("noaa", "wind_speed", start, end)
    wind_density = db.get_sensor_history("noaa", "wind_density", start, end)
    imf_bt = db.get_sensor_history("noaa", "imf_bt", start, end)
    imf_bz = db.get_sensor_history("noaa", "imf_bz", start, end)
    
    return {
        "outdoor": outdoor_history,
        "indoor": indoor_history,
        "forecast": forecast_history,
        "forecast_wwp": forecast_wwp,
        "forecast_sund": forecast_sund,
        "additional": additional_history,
        "kp": kp_history,
        "wind_speed": wind_speed,
        "wind_density": wind_density,
        "imf_bt": imf_bt,
        "imf_bz": imf_bz
    }

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
    
    # Seed database from existing cache if available
    cache = load_cache_from_disk()
    if cache:
        db.insert_forecast_readings(cache.forecast.station_id, cache.forecast.timesteps, cache.forecast.elements)
    
    if mqtt_manager:
        mqtt_manager.start()
    if mqtt_manager_indoor:
        mqtt_manager_indoor.start()

    logger.info(f"Starting server with station_id={config.station_id}, cache_expiry_secs={config.cache_expiry_secs}s")
    uvicorn.run("dwd_server.main:app", host=config.host, port=config.port, reload=False)

if __name__ == "__main__":
    run()
