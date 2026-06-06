import time
import json
import re
import logging
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo
from dwd_server.database import Database

logger = logging.getLogger("dwd_server.mim")

last_mim_fetch_time = 0.0

def fetch_and_store_mim_weather(database: Database) -> None:
    global last_mim_fetch_time
    now = time.time()
    if now - last_mim_fetch_time < 1800:
        logger.info("MIM weather fetch cooldown active, skipping polling.")
        return
        
    last_mim_fetch_time = now
    url = "https://www.meteo.physik.uni-muenchen.de/~quicklooks/aktuelle_messwerte/messwerte_stadt.html"
    try:
        logger.info("Polling MIM Munich local weather data...")
        req = urllib.request.Request(
            url, 
            headers={'User-Agent': 'Mozilla/5.0 (DwdWeatherHub)'}
        )
        with urllib.request.urlopen(req, timeout=5) as response:
            html = response.read().decode('utf-8')
            
        # Parse timestamp
        # Example: Stand: 06.06.2026 17:10 Uhr
        ts_match = re.search(r"Stand:\s*(\d{2})\.(\d{2})\.(\d{4})\s*(\d{2}):(\d{2})\s*Uhr", html)
        if not ts_match:
            logger.warning("Failed to find timestamp in MIM HTML.")
            return
            
        day, month, year, hour, minute = map(int, ts_match.groups())
        dt = datetime(year, month, day, hour, minute, tzinfo=ZoneInfo("Europe/Berlin"))
        utc_dt = dt.astimezone(ZoneInfo("UTC"))
        timestamp = utc_dt.strftime("%Y-%m-%dT%H:%M:00.000Z")
        
        # Helper to find row values
        def get_row_value(html_str: str, row_label: str) -> float | None:
            regex = r"<tr>\s*<td[^>]*>" + re.escape(row_label) + r"</td>\s*<td>(-?\d+\.?\d*)"
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
            r"Globalstr\..*?Diffusstr\..*?Atm\.\s*Gegenstr\..*?</tr>\s*<tr>\s*<td>\s*(-?\d+\.?\d*)\s*W/m.*?<td>\s*(-?\d+\.?\d*)\s*W/m.*?<td>\s*(-?\d+\.?\d*)\s*W/m",
            html,
            re.DOTALL
        )
        if rad_match:
            global_rad = float(rad_match.group(1))
            diffuse_rad = float(rad_match.group(2))
            atm_rad = float(rad_match.group(3))
            
        # Store in database
        readings = []
        if temp is not None:
            readings.append((timestamp, "mim", "temp", temp))
        if humidity is not None:
            readings.append((timestamp, "mim", "humidity", humidity))
        if wind_speed is not None:
            readings.append((timestamp, "mim", "wind_speed", wind_speed))
        if wind_dir is not None:
            readings.append((timestamp, "mim", "wind_dir", wind_dir))
        if global_rad is not None:
            readings.append((timestamp, "mim", "global_rad", global_rad))
        if diffuse_rad is not None:
            readings.append((timestamp, "mim", "diffuse_rad", diffuse_rad))
        if atm_rad is not None:
            readings.append((timestamp, "mim", "atm_rad", atm_rad))
            
        if readings:
            database.insert_sensor_readings(readings)
            logger.info(f"Successfully populated {len(readings)} MIM Munich weather readings in DB.")
    except Exception as e:
        logger.warning(f"Failed to fetch or parse MIM Munich weather: {e}")
