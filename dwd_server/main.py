import logging
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
from dwd_server.noaa import fetch_and_store_space_weather
from dwd_server.mim import fetch_and_store_mim_weather
from dwd_server.scheduler import BackgroundScheduler, ScheduledTask

# Set up logging
logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
    level=logging.INFO
)
logger = logging.getLogger("dwd_server.main")

config: AppConfig = load_config()

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

# ---------------------------------------------------------------------------
# Poll intervals
# ---------------------------------------------------------------------------
FORECAST_MIN_INTERVAL_SECS = 3600   # 60 min
NOAA_INTERVAL_SECS = 1800           # 30 min
MIM_INTERVAL_SECS = 1800            # 30 min
MQTT_HEALTH_INTERVAL_SECS = 600     # 10 min

# Wall-clock timestamps of last successful update (for /api/status)
_last_noaa_update: float = 0.0
_last_mim_update: float = 0.0

def _poll_forecast() -> None:
    """Background task: fetch DWD forecast and update cache. Never raises."""
    cache = load_cache_from_disk()
    now = time.time()

    if cache is not None:
        elapsed = now - cache.last_updated
        if elapsed < FORECAST_MIN_INTERVAL_SECS:
            logger.info(
                f"[scheduler] Forecast rate-limited — last update was {elapsed:.0f}s ago. Skipping."
            )
            return

    station_id = config.station_id
    logger.info(f"[scheduler] Fetching DWD forecast for station {station_id}...")
    new_forecast = fetch_and_parse(station_id)
    if new_forecast is not None:
        write_cache_to_disk(new_forecast)
        logger.info(f"[scheduler] DWD forecast updated for station {station_id}.")
    else:
        logger.warning(f"[scheduler] DWD forecast fetch failed; cache unchanged.")

def _poll_noaa() -> None:
    global _last_noaa_update
    success = fetch_and_store_space_weather(db)
    if success:
        _last_noaa_update = time.time()

def _poll_mim() -> None:
    global _last_mim_update
    success = fetch_and_store_mim_weather(db)
    if success:
        _last_mim_update = time.time()

def _poll_mqtt_health() -> None:
    """Check each MQTT topic for staleness; inject null sentinels for silent topics."""
    if mqtt_manager:
        mqtt_manager.inject_stale_sentinels()
    if mqtt_manager_indoor:
        mqtt_manager_indoor.inject_stale_sentinels()

def update_forecast_on_demand() -> WeatherForecast:
    """On-demand fetch (from HTTP endpoints). Raises HTTPException on total failure."""
    cache = load_cache_from_disk()
    station_id = config.station_id

    logger.info(f"On-demand refresh triggered for station {station_id}")
    new_forecast = fetch_and_parse(station_id)

    if new_forecast is not None:
        write_cache_to_disk(new_forecast)
        return new_forecast

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

    is_rate_limited = False
    if cache is not None:
        elapsed = now - cache.last_updated
        if elapsed < FORECAST_MIN_INTERVAL_SECS:
            is_rate_limited = True

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
            logger.info("DWD update requested but rate-limited. Serving from cache.")
            result_forecast = cache.forecast  # type: ignore
            source = "cache (rate-limited)"
            last_updated = cache.last_updated  # type: ignore
        else:
            result_forecast = update_forecast_on_demand()
            source = "network"
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
        "next_allowed_update": last_updated + FORECAST_MIN_INTERVAL_SECS,
        "cache_expiry_secs": config.cache_expiry_secs,
        "forecast": result_forecast,
        "mqtt_last_measurement": mqtt_data.get("last_measurement"),
        "mqtt_history": mqtt_data.get("history"),
        "mqtt_indoor_last_measurement": mqtt_indoor_data.get("last_measurement"),
        "mqtt_indoor_history": mqtt_indoor_data.get("history")
    }


# ---------------------------------------------------------------------------
# Background scheduler (module-level so /api/status can access it)
# ---------------------------------------------------------------------------
_scheduler: BackgroundScheduler | None = None


@app.get("/api/forecast")
def get_forecast() -> dict[str, Any]:
    return get_forecast_data(force_refresh=False)

@app.post("/api/refresh")
def refresh_forecast() -> dict[str, Any]:
    return get_forecast_data(force_refresh=True)

@app.get("/api/history")
def get_history(start: str, end: str) -> dict[str, Any]:
    # Data is kept fresh by the BackgroundScheduler — pure DB read here.
    outdoor_history: list[dict[str, Any]] = []
    if config.mqtt_topic:
        outdoor_history = db.get_sensor_history(config.mqtt_topic, "temperature", start, end)

    indoor_history: list[dict[str, Any]] = []
    if config.mqtt_topic_indoor:
        indoor_history = db.get_sensor_history(config.mqtt_topic_indoor, "temperature", start, end)

    forecast_history = db.get_forecast_history(config.station_id, "TTT", start, end)
    forecast_wwp = db.get_forecast_history(config.station_id, "wwP", start, end)
    forecast_sund = db.get_forecast_history(config.station_id, "SunD1", start, end)

    additional_history: dict[str, list[dict[str, Any]]] = {}
    for topic in config.mqtt_additional_topics:
        metric = topic.split('/')[-1]
        additional_history[topic] = db.get_sensor_history(topic, metric, start, end)

    kp_history = db.get_sensor_history("noaa", "kp", start, end)
    wind_speed = db.get_sensor_history("noaa", "wind_speed", start, end)
    wind_density = db.get_sensor_history("noaa", "wind_density", start, end)
    imf_bt = db.get_sensor_history("noaa", "imf_bt", start, end)
    imf_bz = db.get_sensor_history("noaa", "imf_bz", start, end)

    mim_temp = db.get_sensor_history("mim", "temp", start, end)
    mim_humidity = db.get_sensor_history("mim", "humidity", start, end)
    mim_wind_speed = db.get_sensor_history("mim", "wind_speed", start, end)
    mim_wind_dir = db.get_sensor_history("mim", "wind_dir", start, end)
    mim_global_rad = db.get_sensor_history("mim", "global_rad", start, end)
    mim_diffuse_rad = db.get_sensor_history("mim", "diffuse_rad", start, end)
    mim_atm_rad = db.get_sensor_history("mim", "atm_rad", start, end)

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
        "imf_bz": imf_bz,
        "mim_temp": mim_temp,
        "mim_humidity": mim_humidity,
        "mim_wind_speed": mim_wind_speed,
        "mim_wind_dir": mim_wind_dir,
        "mim_global_rad": mim_global_rad,
        "mim_diffuse_rad": mim_diffuse_rad,
        "mim_atm_rad": mim_atm_rad
    }

@app.get("/api/status")
def get_status() -> dict[str, Any]:
    """Return health status of every data source for the dashboard status panel."""
    now_wall = time.time()
    now_mono = time.monotonic()

    # --- DWD Forecast ---
    cache = load_cache_from_disk()
    if cache is not None:
        forecast_age = now_wall - cache.last_updated
        forecast_last = cache.last_updated
    else:
        forecast_age = None
        forecast_last = None

    # --- Scheduler task last-run times (convert monotonic → approximate wall clock) ---
    scheduler_status: dict[str, dict[str, float]] = {}
    if _scheduler is not None:
        for name, info in _scheduler.get_status().items():
            last_mono = info["last_run"]
            if last_mono > 0:
                # Approximate wall-clock: now_wall - (now_mono - last_mono)
                wall_approx = now_wall - (now_mono - last_mono)
                age = now_wall - wall_approx
            else:
                wall_approx = 0.0
                age = None  # type: ignore
            scheduler_status[name] = {
                "last_run_wall": wall_approx,
                "age_secs": age,
                "interval_secs": info["interval_secs"],
            }

    # --- MQTT sensors ---
    mqtt_statuses: dict[str, Any] = {}
    if mqtt_manager:
        for topic, s in mqtt_manager.get_topic_statuses().items():
            mqtt_statuses[topic] = {
                "last_seen": s["last_seen"],
                "age_secs": s["age_secs"],
                "is_stale": s["is_stale"],
                "stale_threshold_secs": mqtt_manager.stale_threshold_secs,
                "group": "outdoor",
            }
    if mqtt_manager_indoor:
        for topic, s in mqtt_manager_indoor.get_topic_statuses().items():
            mqtt_statuses[topic] = {
                "last_seen": s["last_seen"],
                "age_secs": s["age_secs"],
                "is_stale": s["is_stale"],
                "stale_threshold_secs": mqtt_manager_indoor.stale_threshold_secs,
                "group": "indoor",
            }

    # --- NOAA & MIM use last successful updates ---
    noaa_age = now_wall - _last_noaa_update if _last_noaa_update > 0.0 else None
    mim_age = now_wall - _last_mim_update if _last_mim_update > 0.0 else None

    # Calculate time remaining until next scheduled attempt (based on last attempt age)
    forecast_next = max(0.0, FORECAST_MIN_INTERVAL_SECS - forecast_age) if forecast_age is not None else None
    noaa_next = max(0.0, NOAA_INTERVAL_SECS - noaa_info.get("age_secs")) if noaa_info.get("age_secs") is not None else None
    mim_next = max(0.0, MIM_INTERVAL_SECS - mim_info.get("age_secs")) if mim_info.get("age_secs") is not None else None

    return {
        "sources": {
            "forecast": {
                "label": "DWD Forecast",
                "last_updated": forecast_last,
                "age_secs": forecast_age,
                "interval_secs": FORECAST_MIN_INTERVAL_SECS,
                "is_stale": forecast_age is None or forecast_age > FORECAST_MIN_INTERVAL_SECS * 2,
                "next_poll_in": forecast_next,
            },
            "noaa": {
                "label": "NOAA Space Weather",
                "last_updated": _last_noaa_update if _last_noaa_update > 0.0 else None,
                "age_secs": noaa_age,
                "interval_secs": NOAA_INTERVAL_SECS,
                "is_stale": (
                    _last_noaa_update == 0.0
                    or noaa_age is None
                    or noaa_age > NOAA_INTERVAL_SECS * 3
                ),
                "next_poll_in": noaa_next,
            },
            "mim": {
                "label": "MIM Munich Weather",
                "last_updated": _last_mim_update if _last_mim_update > 0.0 else None,
                "age_secs": mim_age,
                "interval_secs": MIM_INTERVAL_SECS,
                "is_stale": (
                    _last_mim_update == 0.0
                    or mim_age is None
                    or mim_age > MIM_INTERVAL_SECS * 3
                ),
                "next_poll_in": mim_next,
            },
        },
        "mqtt": mqtt_statuses,
        "mqtt_stale_threshold_secs": (
            mqtt_manager.stale_threshold_secs if mqtt_manager else 900
        ),
    }

@app.get("/api/config")
def get_current_config() -> dict[str, Any]:
    return {
        "station_id": config.station_id,
        "cache_expiry_secs": config.cache_expiry_secs,
        "forecast_min_interval_secs": FORECAST_MIN_INTERVAL_SECS,
        "noaa_interval_secs": NOAA_INTERVAL_SECS,
        "mim_interval_secs": MIM_INTERVAL_SECS,
        "mqtt_health_interval_secs": MQTT_HEALTH_INTERVAL_SECS,
        "port": config.port,
        "host": config.host
    }


# Ensure static files directory exists before mounting
static_dir = Path(__file__).parent / "static"
if not static_dir.exists():
    static_dir.mkdir(parents=True, exist_ok=True)

app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")


def run() -> None:
    global _scheduler, _last_noaa_update, _last_mim_update
    ensure_cache_dir()

    # Query the last successful update timestamps from the database if they exist
    _last_noaa_update = db.get_last_successful_reading_time("noaa") or 0.0
    _last_mim_update = db.get_last_successful_reading_time("mim") or 0.0

    # Seed database from existing cache if available
    cache = load_cache_from_disk()
    if cache:
        db.insert_forecast_readings(cache.forecast.station_id, cache.forecast.timesteps, cache.forecast.elements)

    if mqtt_manager:
        mqtt_manager.start()
    if mqtt_manager_indoor:
        mqtt_manager_indoor.start()

    # -------------------------------------------------------------------
    # Background scheduler — independent poll intervals per source:
    #   forecast:     60 min  (DWD MOSMIX_L updated ~4×/day)
    #   noaa:         30 min  (space weather)
    #   mim:          30 min  (Munich local weather scrape)
    #   mqtt_health:  10 min  (detect stale MQTT topics, insert null sentinels)
    # MQTT sensors themselves are event-driven (push); no polling needed.
    # -------------------------------------------------------------------
    _scheduler = BackgroundScheduler(
        tasks=[
            ScheduledTask(
                name="forecast",
                fn=_poll_forecast,
                interval_secs=FORECAST_MIN_INTERVAL_SECS,
            ),
            ScheduledTask(
                name="noaa",
                fn=_poll_noaa,
                interval_secs=NOAA_INTERVAL_SECS,
            ),
            ScheduledTask(
                name="mim",
                fn=_poll_mim,
                interval_secs=MIM_INTERVAL_SECS,
            ),
            ScheduledTask(
                name="mqtt_health",
                fn=_poll_mqtt_health,
                interval_secs=MQTT_HEALTH_INTERVAL_SECS,
            ),
        ],
        tick_secs=30,
    )
    _scheduler.start()

    logger.info(
        f"Starting server with station_id={config.station_id}, "
        f"forecast={FORECAST_MIN_INTERVAL_SECS}s, "
        f"noaa={NOAA_INTERVAL_SECS}s, mim={MIM_INTERVAL_SECS}s, "
        f"mqtt_health={MQTT_HEALTH_INTERVAL_SECS}s"
    )
    uvicorn.run("dwd_server.main:app", host=config.host, port=config.port, reload=False)


if __name__ == "__main__":
    run()
