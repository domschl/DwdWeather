import json
import re
import logging
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from dwd_server.database import Database

logger = logging.getLogger("dwd_server.mim")

MIM_METRICS = ("temp", "humidity", "wind_speed", "wind_dir", "global_rad", "diffuse_rad", "atm_rad")


def _current_poll_slot() -> str:
    """Return the current 30-minute aligned UTC slot as ISO timestamp string."""
    now = datetime.now(timezone.utc)
    aligned_minute = (now.minute // 30) * 30
    slot = now.replace(minute=aligned_minute, second=0, microsecond=0)
    return slot.strftime("%Y-%m-%dT%H:%M:00.000Z")


def fetch_and_store_mim_weather(database: Database) -> bool:
    """Fetch MIM Munich weather data and store it in the database.

    On failure, inserts NULL sentinel rows for all MIM metrics at the current
    poll slot so the time-series has an explicit gap marker.
    Returns True on success, False on failure.
    """
    url = "https://www.meteo.physik.uni-muenchen.de/~quicklooks/aktuelle_messwerte/messwerte_stadt.html"
    try:
        logger.info("Polling MIM Munich local weather data...")
        req = urllib.request.Request(
            url,
            headers={'User-Agent': 'Mozilla/5.0 (DwdWeatherHub)'}
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            html = response.read().decode('utf-8')

        # Parse timestamp
        # Example: Stand: 06.06.2026 17:10 Uhr
        # Make regex more robust by allowing optional comma/spaces between date and time
        ts_match = re.search(r"Stand:\s*(\d{2})\.(\d{2})\.(\d{4})[,\s]*(\d{2}):(\d{2})\s*Uhr", html)
        if not ts_match:
            logger.warning("Failed to find timestamp in MIM HTML — inserting null sentinels.")
            _insert_null_sentinels(database)
            return False

        day, month, year, hour, minute = map(int, ts_match.groups())
        
        # Support 24:00 as 00:00 of the next day
        if hour == 24:
            from datetime import timedelta
            dt = datetime(year, month, day, 0, minute, tzinfo=ZoneInfo("Europe/Berlin")) + timedelta(days=1)
        else:
            dt = datetime(year, month, day, hour, minute, tzinfo=ZoneInfo("Europe/Berlin"))
            
        utc_dt = dt.astimezone(ZoneInfo("UTC"))
        timestamp = utc_dt.strftime("%Y-%m-%dT%H:%M:00.000Z")

        # Helper to find row values
        def get_row_value(html_str: str, row_label: str) -> float | None:
            regex = r"<tr>\s*<td[^>]*>\s*" + re.escape(row_label) + r"\s*</td>\s*<td[^>]*>\s*(-?\d+\.?\d*)"
            match = re.search(regex, html_str, re.IGNORECASE)
            if match:
                return float(match.group(1))
            return None

        temp = get_row_value(html, "Lufttemperatur")
        humidity = get_row_value(html, "Relative Feuchte")
        wind_speed = get_row_value(html, "Windgeschwindigkeit 30 m")
        wind_dir = get_row_value(html, "Windrichtung 30 m")

        # Parse radiation
        global_rad = None
        diffuse_rad = None
        atm_rad = None
        rad_match = re.search(
            r"Globalstr\..*?Diffusstr\..*?Atm\.\s*Gegenstr\..*?</tr>\s*<tr>\s*<td[^>]*>\s*(-?\d+\.?\d*)\s*W/m.*?<td[^>]*>\s*(-?\d+\.?\d*)\s*W/m.*?<td[^>]*>\s*(-?\d+\.?\d*)\s*W/m",
            html,
            re.DOTALL
        )
        if rad_match:
            global_rad = float(rad_match.group(1))
            diffuse_rad = float(rad_match.group(2))
            atm_rad = float(rad_match.group(3))

        # Store in database — include null sentinels for any missing fields
        readings: list[tuple[str, str, str, float | None]] = [
            (timestamp, "mim", "temp", temp),
            (timestamp, "mim", "humidity", humidity),
            (timestamp, "mim", "wind_speed", wind_speed),
            (timestamp, "mim", "wind_dir", wind_dir),
            (timestamp, "mim", "global_rad", global_rad),
            (timestamp, "mim", "diffuse_rad", diffuse_rad),
            (timestamp, "mim", "atm_rad", atm_rad),
        ]

        database.insert_sensor_readings(readings)
        non_null = sum(1 for r in readings if r[3] is not None)
        logger.info(f"Stored {non_null} MIM readings ({len(readings) - non_null} null) in DB.")
        return non_null > 0
    except Exception as e:
        logger.warning(f"Failed to fetch or parse MIM Munich weather: {e} — inserting null sentinels.")
        _insert_null_sentinels(database)
        return False


def _insert_null_sentinels(database: Database) -> None:
    """Insert NULL sentinel rows for all MIM metrics at the current poll slot."""
    slot = _current_poll_slot()
    sentinels: list[tuple[str, str, str, float | None]] = [
        (slot, "mim", metric, None) for metric in MIM_METRICS
    ]
    database.insert_sensor_readings(sentinels)
    logger.info(f"Inserted {len(sentinels)} MIM null sentinel rows at slot {slot}.")
