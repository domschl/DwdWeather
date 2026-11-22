"""Hiking conditions manager: multi-station DWD MOSMIX_L caching, Open-Meteo snow depth, and DWD station catalog search."""

import json
import logging
import re
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any

from dwd_server.parser import WeatherForecast, fetch_and_parse

logger = logging.getLogger("dwd_server.hiking")

STATION_CATALOG_URL = (
    "https://www.dwd.de/DE/leistungen/met_verfahren_mosmix/"
    "mosmix_stationskatalog.cfg?view=nasPublication"
)
STATION_CATALOG_TTL_SECS = 7 * 86400  # 7 days
HIKING_CACHE_TTL_SECS = 3600  # 60 minutes (aligned with DWD MOSMIX_L rate limit)


def _ddmm_to_decimal(val_str: str) -> float | None:
    """Convert DWD catalog DD.MM (degrees.minutes) string to decimal degrees."""
    try:
        val = float(val_str)
    except ValueError:
        return None
    sign = -1.0 if val < 0 else 1.0
    abs_val = abs(val)
    deg = int(abs_val)
    minutes = (abs_val - deg) * 100.0
    return round(sign * (deg + minutes / 60.0), 4)


def _parse_station_catalog(raw_text: str) -> list[dict[str, Any]]:
    """Parse DWD mosmix_stationskatalog.cfg fixed-width lines."""
    stations: list[dict[str, Any]] = []
    # Example line:
    # ' P966 ---- OBERE FIRSTALM/SCHLI  47.40   11.51  1369'
    # '10865 ---- MUENCHEN STADT        48.10   11.32   515'
    line_re = re.compile(
        r"^\s*([A-Za-z0-9]{4,5})\s+(\S+)\s+(.+?)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+)\s*$"
    )
    for line in raw_text.splitlines():
        m = line_re.match(line)
        if not m:
            continue
        sid, _icao, name, lat_s, lon_s, elev_s = m.groups()
        lat = _ddmm_to_decimal(lat_s)
        lon = _ddmm_to_decimal(lon_s)
        try:
            elev = int(elev_s)
        except ValueError:
            elev = 0
        if lat is None or lon is None:
            continue
        stations.append({
            "id": sid.strip(),
            "name": name.strip(),
            "lat": lat,
            "lon": lon,
            "elevation": elev,
        })
    return stations


def fetch_snow_depth(lat: float, lon: float, elevation: float | None = None) -> dict[str, float | None]:
    """Fetch 10-day hourly snow_depth (in cm) from Open-Meteo keyed by 'YYYY-MM-DDTHH:00' UTC."""
    url = (
        f"https://api.open-meteo.com/v1/forecast"
        f"?latitude={lat:.4f}&longitude={lon:.4f}"
        f"&hourly=snow_depth&forecast_days=11&timezone=UTC"
    )
    if elevation is not None and elevation > 0:
        url += f"&elevation={int(round(elevation))}"
    logger.info(f"Fetching Open-Meteo snow_depth from: {url}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "DwdWeatherModernizer/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            payload = json.loads(resp.read())
        hourly = payload.get("hourly", {})
        times = hourly.get("time", [])
        depths = hourly.get("snow_depth", [])
        result: dict[str, float | None] = {}
        for t, d in zip(times, depths):
            # Open-Meteo returns meters; convert to cm
            result[str(t)] = round(float(d) * 100.0, 1) if d is not None else None
        return result
    except Exception as e:
        logger.warning(f"Failed to fetch Open-Meteo snow_depth for ({lat}, {lon}): {e}")
        return {}


def _align_snow_depth(timesteps: list[str], snow_map: dict[str, float | None]) -> list[float | None]:
    """Align Open-Meteo snow_depth ('YYYY-MM-DDTHH:00') onto MOSMIX_L timesteps ('YYYY-MM-DDTHH:00:00.000Z')."""
    aligned: list[float | None] = []
    for ts in timesteps:
        key = ts[:16]  # 'YYYY-MM-DDTHH:MM'
        aligned.append(snow_map.get(key))
    return aligned


class HikingManager:
    """Manages hiking locations, per-station forecast+snow caches, and DWD station catalog search."""

    def __init__(self, cache_dir: Path, default_stations: list[dict[str, str]]) -> None:
        self.cache_dir = cache_dir
        self.default_stations = default_stations
        self.locations_file = cache_dir / "hiking_locations.json"
        self.catalog_file = cache_dir / "mosmix_stations.json"
        self._lock = threading.RLock()
        self._station_cache: dict[str, dict[str, Any]] = {}
        self._catalog: list[dict[str, Any]] | None = None
        self._catalog_updated: float = 0.0

    def _ensure_dir(self) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Station catalog
    # ------------------------------------------------------------------
    def _load_catalog(self) -> list[dict[str, Any]]:
        now = time.time()
        if self._catalog is not None and (now - self._catalog_updated) < STATION_CATALOG_TTL_SECS:
            return self._catalog

        if self.catalog_file.is_file():
            try:
                with open(self.catalog_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                updated = float(data.get("last_updated", 0.0))
                stations = data.get("stations", [])
                if stations and (now - updated) < STATION_CATALOG_TTL_SECS:
                    self._catalog = stations
                    self._catalog_updated = updated
                    return stations
            except Exception as e:
                logger.warning(f"Failed to read cached MOSMIX station catalog: {e}")

        # Fetch fresh catalog from DWD
        try:
            logger.info(f"Fetching DWD MOSMIX station catalog from {STATION_CATALOG_URL}")
            req = urllib.request.Request(
                STATION_CATALOG_URL,
                headers={"User-Agent": "DwdWeatherModernizer/1.0"},
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                raw_text = resp.read().decode("latin-1", errors="replace")
            stations = _parse_station_catalog(raw_text)
            if stations:
                self._ensure_dir()
                with open(self.catalog_file, "w", encoding="utf-8") as f:
                    json.dump({"last_updated": now, "stations": stations}, f, ensure_ascii=False)
                self._catalog = stations
                self._catalog_updated = now
                logger.info(f"Cached {len(stations)} DWD MOSMIX stations.")
                return stations
        except Exception as e:
            logger.error(f"Failed to fetch DWD MOSMIX station catalog: {e}")

        # Fallback to stale disk cache if available
        if self.catalog_file.is_file():
            try:
                with open(self.catalog_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                stations = data.get("stations", [])
                if stations:
                    self._catalog = stations
                    self._catalog_updated = float(data.get("last_updated", 0.0))
                    return stations
            except Exception:
                pass
        return []

    def search_stations(self, query: str, limit: int = 20) -> list[dict[str, Any]]:
        q = query.strip().lower()
        if not q:
            return []
        catalog = self._load_catalog()
        exact_id: list[dict[str, Any]] = []
        prefix_matches: list[dict[str, Any]] = []
        contains_matches: list[dict[str, Any]] = []

        for st in catalog:
            sid_l = st["id"].lower()
            name_l = st["name"].lower()
            if sid_l == q:
                exact_id.append(st)
            elif sid_l.startswith(q) or name_l.startswith(q):
                prefix_matches.append(st)
            elif q in sid_l or q in name_l:
                contains_matches.append(st)

        # Sort prefix/contains matches by name
        prefix_matches.sort(key=lambda s: s["name"])
        contains_matches.sort(key=lambda s: s["name"])
        return (exact_id + prefix_matches + contains_matches)[:limit]

    # ------------------------------------------------------------------
    # Persisted hiking locations
    # ------------------------------------------------------------------
    def load_locations(self) -> list[dict[str, str]]:
        with self._lock:
            if self.locations_file.is_file():
                try:
                    with open(self.locations_file, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    if isinstance(data, list):
                        return [
                            {
                                "station_id": str(item["station_id"]).strip(),
                                "label": str(item.get("label", "")).strip(),
                            }
                            for item in data
                            if isinstance(item, dict) and item.get("station_id")
                        ]
                except Exception as e:
                    logger.warning(f"Failed to read hiking_locations.json: {e}")

            # Initialize from defaults
            locs = [
                {
                    "station_id": str(item["station_id"]).strip(),
                    "label": str(item.get("label", "")).strip(),
                }
                for item in self.default_stations
                if item.get("station_id")
            ]
            self.save_locations(locs)
            return locs

    def save_locations(self, locations: list[dict[str, str]]) -> None:
        with self._lock:
            self._ensure_dir()
            with open(self.locations_file, "w", encoding="utf-8") as f:
                json.dump(locations, f, ensure_ascii=False, indent=2)

    # ------------------------------------------------------------------
    # Per-station forecast + snow depth caching
    # ------------------------------------------------------------------
    def _station_cache_path(self, station_id: str) -> Path:
        safe_id = re.sub(r"[^A-Za-z0-9_-]", "_", station_id)
        return self.cache_dir / f"hiking_{safe_id}.json"

    def _load_station_cache(self, station_id: str) -> dict[str, Any] | None:
        if station_id in self._station_cache:
            return self._station_cache[station_id]
        path = self._station_cache_path(station_id)
        if not path.is_file():
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if "forecast" in data and "last_updated" in data:
                self._station_cache[station_id] = data
                return data
        except Exception as e:
            logger.warning(f"Failed to read hiking cache for {station_id}: {e}")
        return None

    def _save_station_cache(
        self, station_id: str, forecast: WeatherForecast, snow_depth_cm: list[float | None]
    ) -> dict[str, Any]:
        self._ensure_dir()
        entry: dict[str, Any] = {
            "last_updated": time.time(),
            "forecast": forecast.model_dump(),
            "snow_depth_cm": snow_depth_cm,
        }
        self._station_cache[station_id] = entry
        try:
            with open(self._station_cache_path(station_id), "w", encoding="utf-8") as f:
                json.dump(entry, f, ensure_ascii=False)
        except Exception as e:
            logger.error(f"Failed to write hiking cache for {station_id}: {e}")
        return entry

    def get_station_data(
        self, station_id: str, label: str = "", force_refresh: bool = False
    ) -> dict[str, Any] | None:
        """Fetch or return cached forecast + snow depth for a single hiking station."""
        now = time.time()
        cached = self._load_station_cache(station_id)

        # Also refresh if cached forecast is missing R101 (e.g. older cache format)
        needs_upgrade = (
            cached is not None
            and "R101" not in cached.get("forecast", {}).get("elements", {})
        )

        if cached is not None and not needs_upgrade:
            age = now - float(cached["last_updated"])
            if not force_refresh and age < HIKING_CACHE_TTL_SECS:
                return {
                    "station_id": station_id,
                    "label": label or cached["forecast"].get("station_name") or station_id,
                    "source": "cache",
                    "last_updated": cached["last_updated"],
                    "forecast": cached["forecast"],
                    "snow_depth_cm": cached.get("snow_depth_cm", []),
                }
            if force_refresh and age < HIKING_CACHE_TTL_SECS:
                return {
                    "station_id": station_id,
                    "label": label or cached["forecast"].get("station_name") or station_id,
                    "source": "cache (rate-limited)",
                    "last_updated": cached["last_updated"],
                    "forecast": cached["forecast"],
                    "snow_depth_cm": cached.get("snow_depth_cm", []),
                }

        forecast = fetch_and_parse(station_id)
        if forecast is not None:
            coords = forecast.coordinates  # [lon, lat, elev]
            snow_map: dict[str, float | None] = {}
            if len(coords) >= 2 and (coords[0] != 0.0 or coords[1] != 0.0):
                elev = coords[2] if len(coords) > 2 else None
                snow_map = fetch_snow_depth(coords[1], coords[0], elev)
            snow_depth_cm = _align_snow_depth(forecast.timesteps, snow_map)
            entry = self._save_station_cache(station_id, forecast, snow_depth_cm)
            return {
                "station_id": station_id,
                "label": label or forecast.station_name or station_id,
                "source": "network",
                "last_updated": entry["last_updated"],
                "forecast": entry["forecast"],
                "snow_depth_cm": snow_depth_cm,
            }

        if cached is not None:
            logger.warning(f"DWD fetch failed for hiking station {station_id}; serving stale cache.")
            return {
                "station_id": station_id,
                "label": label or cached["forecast"].get("station_name") or station_id,
                "source": "cache (stale)",
                "last_updated": cached["last_updated"],
                "forecast": cached["forecast"],
                "snow_depth_cm": cached.get("snow_depth_cm", []),
            }

        return None

    def get_all_locations_data(self, force_refresh: bool = False) -> list[dict[str, Any]]:
        locations = self.load_locations()
        results: list[dict[str, Any]] = []
        for loc in locations:
            sid = loc["station_id"]
            lbl = loc.get("label", "")
            data = self.get_station_data(sid, label=lbl, force_refresh=force_refresh)
            if data is not None:
                results.append(data)
            else:
                results.append({
                    "station_id": sid,
                    "label": lbl or sid,
                    "source": "error",
                    "last_updated": None,
                    "forecast": None,
                    "snow_depth_cm": [],
                    "error": f"Failed to fetch DWD forecast for station {sid}",
                })
        return results

    def add_location(self, station_id: str, label: str = "") -> dict[str, Any]:
        sid = station_id.strip()
        lbl = label.strip()
        data = self.get_station_data(sid, label=lbl, force_refresh=False)
        if data is None:
            raise ValueError(f"Station '{sid}' could not be retrieved from DWD MOSMIX_L.")

        with self._lock:
            locations = self.load_locations()
            existing = next((l for l in locations if l["station_id"].lower() == sid.lower()), None)
            if existing is not None:
                if lbl:
                    existing["label"] = lbl
                    data["label"] = lbl
            else:
                locations.append({
                    "station_id": sid,
                    "label": lbl or data["forecast"].get("station_name") or sid,
                })
            self.save_locations(locations)
        return data

    def remove_location(self, station_id: str) -> bool:
        sid = station_id.strip().lower()
        with self._lock:
            locations = self.load_locations()
            new_locations = [l for l in locations if l["station_id"].lower() != sid]
            if len(new_locations) == len(locations):
                return False
            self.save_locations(new_locations)
            return True
