import time
import json
import logging
import urllib.request
from datetime import datetime, timezone
from dwd_server.database import Database

logger = logging.getLogger("dwd_server.noaa")


def _current_poll_slot() -> str:
    """Return the current 30-minute aligned UTC slot as ISO timestamp string."""
    now = datetime.now(timezone.utc)
    aligned_minute = (now.minute // 30) * 30
    slot = now.replace(minute=aligned_minute, second=0, microsecond=0)
    return slot.strftime("%Y-%m-%dT%H:%M:00.000Z")


def fetch_and_store_space_weather(database: Database) -> bool:
    """Fetch NOAA space weather data and store it in the database.

    On failure of any individual sub-fetch, inserts a NULL sentinel row for
    that metric so the time-series has an explicit gap marker instead of a
    silent hole.
    Returns True on success, False on failure.
    """
    raw_groups: dict[tuple[str, str, str], list[float]] = {}
    failed_metrics: set[tuple[str, str]] = set()

    # 1. Fetch Planetary Kp Index
    try:
        logger.info("Polling NOAA Kp-index space weather data...")
        req = urllib.request.Request(
            "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json",
            headers={'User-Agent': 'Mozilla/5.0 (DwdWeatherHub)'}
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode('utf-8'))
            for item in data:
                time_tag = item.get("time_tag")
                kp_val = item.get("estimated_kp")
                if time_tag and kp_val is not None:
                    dt = datetime.fromisoformat(time_tag)
                    dt_10m = dt.replace(minute=(dt.minute // 10) * 10, second=0, microsecond=0)
                    timestamp = dt_10m.strftime("%Y-%m-%dT%H:%M:00.000Z")
                    raw_groups.setdefault((timestamp, "noaa", "kp"), []).append(float(kp_val))
        logger.info("Loaded NOAA Kp-index data.")
    except Exception as e:
        logger.warning(f"Failed to fetch NOAA Kp-index: {e}")
        failed_metrics.add(("noaa", "kp"))

    # 2. Fetch RTSW Solar Wind Plasma
    try:
        logger.info("Polling NOAA solar wind plasma data...")
        req = urllib.request.Request(
            "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json",
            headers={'User-Agent': 'Mozilla/5.0 (DwdWeatherHub)'}
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode('utf-8'))
            for item in data:
                time_tag = item.get("time_tag")
                speed = item.get("proton_speed")
                density = item.get("proton_density")
                if time_tag:
                    dt = datetime.fromisoformat(time_tag)
                    dt_10m = dt.replace(minute=(dt.minute // 10) * 10, second=0, microsecond=0)
                    timestamp = dt_10m.strftime("%Y-%m-%dT%H:%M:00.000Z")
                    if speed is not None:
                        raw_groups.setdefault((timestamp, "noaa", "wind_speed"), []).append(float(speed))
                    if density is not None:
                        raw_groups.setdefault((timestamp, "noaa", "wind_density"), []).append(float(density))
        logger.info("Loaded NOAA solar wind plasma data.")
    except Exception as e:
        logger.warning(f"Failed to fetch NOAA solar wind plasma: {e}")
        failed_metrics.add(("noaa", "wind_speed"))
        failed_metrics.add(("noaa", "wind_density"))

    # 3. Fetch RTSW Solar Wind Magnetometer
    try:
        logger.info("Polling NOAA solar wind magnetometer data...")
        req = urllib.request.Request(
            "https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json",
            headers={'User-Agent': 'Mozilla/5.0 (DwdWeatherHub)'}
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode('utf-8'))
            for item in data:
                time_tag = item.get("time_tag")
                bt = item.get("bt")
                bz = item.get("bz_gsm")
                if time_tag:
                    dt = datetime.fromisoformat(time_tag)
                    dt_10m = dt.replace(minute=(dt.minute // 10) * 10, second=0, microsecond=0)
                    timestamp = dt_10m.strftime("%Y-%m-%dT%H:%M:00.000Z")
                    if bt is not None:
                        raw_groups.setdefault((timestamp, "noaa", "imf_bt"), []).append(float(bt))
                    if bz is not None:
                        raw_groups.setdefault((timestamp, "noaa", "imf_bz"), []).append(float(bz))
        logger.info("Loaded NOAA solar wind magnetometer data.")
    except Exception as e:
        logger.warning(f"Failed to fetch NOAA solar wind magnetometer: {e}")
        failed_metrics.add(("noaa", "imf_bt"))
        failed_metrics.add(("noaa", "imf_bz"))

    # Calculate average values for each 10-minute slot and perform bulk insert
    readings: list[tuple[str, str, str, float | None]] = []
    for (timestamp, sensor_id, metric), values in raw_groups.items():
        if values:
            avg_val = sum(values) / len(values)
            readings.append((timestamp, sensor_id, metric, avg_val))

    # Insert NULL sentinel rows for failed metrics at the current poll slot
    slot = _current_poll_slot()
    for sensor_id, metric in failed_metrics:
        readings.append((slot, sensor_id, metric, None))

    if readings:
        logger.info(f"Inserting {len(readings)} space weather records into DB "
                    f"({len(failed_metrics)} null sentinel(s))...")
        database.insert_sensor_readings(readings)
        logger.info("Bulk insert finished successfully.")

    return len(raw_groups) > 0
