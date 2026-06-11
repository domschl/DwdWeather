# DWD Weather Hub REST API Documentation

This document describes the REST API exposed by the DWD Weather Hub. The API allows third-party projects and home automation systems (e.g., Home Assistant, Node-RED, or custom dashboards) to integrate forecast data, real-time MQTT sensor readings, space weather metrics, and historical weather data.

---

## 1. General Information

- **Default Base URL**: `http://localhost:8089` (or `http://nalanda:8089` on server environments)
- **Content Type**: `application/json` (unless serving static frontend files)
- **Time Representation**: All timestamps are returned in ISO 8601 UTC format (e.g., `YYYY-MM-DDTHH:MM:SSZ` or `YYYY-MM-DDTHH:MM:SS.sssZ`).

---

## 2. API Endpoints

### 2.1. GET `/api/forecast`
Retrieves the active weather forecast from the Deutscher Wetterdienst (DWD) alongside the latest MQTT sensor readings and their 24-hour history.

- **Request**: `GET /api/forecast`
- **Response Format**:
```json
{
  "source": "network" | "cache" | "cache (rate-limited)",
  "last_updated": 1781251200.0,
  "next_allowed_update": 1781254800.0,
  "cache_expiry_secs": 3600,
  "forecast": {
    "timesteps": [
      "2026-06-11T06:00:00.000Z",
      "2026-06-11T07:00:00.000Z"
    ],
    "elements": {
      "TTT": [280.5, 281.2],
      "SunD1": [0.0, 15.0],
      "wwP": [5.0, 10.0],
      "DRR1": [0.0, 0.0],
      "RR1c": [0.0, 0.0]
    }
  },
  "mqtt_last_measurement": {
    "temp": 18.5,
    "time": "2026-06-11T06:14:30Z"
  },
  "mqtt_history": {
    "2026-06-11T05:00:00Z": 18.2,
    "2026-06-11T06:00:00Z": 18.5
  },
  "mqtt_indoor_last_measurement": {
    "temp": 21.0,
    "time": "2026-06-11T06:14:20Z"
  },
  "mqtt_indoor_history": {
    "2026-06-11T05:00:00Z": 20.8,
    "2026-06-11T06:00:00Z": 21.0
  }
}
```

#### Forecast Metrics (DWD MOSMIX Key Mapping)
- `TTT`: Temperature (Kelvin; to convert to °C subtract `273.15`)
- `SunD1`: Sunshine duration in the last hour (seconds)
- `wwP`: Probability of precipitation in the last hour (%)
- `DRR1`: Precipitation duration in the last hour (seconds)
- `RR1c`: Precipitation amount in the last hour (mm)

---

### 2.2. POST `/api/refresh`
Forces a fresh fetch of the DWD MOSMIX forecast from the DWD server.

- **Request**: `POST /api/refresh`
- **Rate Limiting**: To prevent abuse of DWD endpoints, fetches are rate-limited to once every 1,800 seconds (30 minutes) by default. If a refresh is requested too soon, the endpoint will return cached data with the `"source": "cache (rate-limited)"` flag.
- **Response Format**: Matches `GET /api/forecast`.

---

### 2.3. GET `/api/history`
Fetches historical records from the database for a selected interval. This incorporates DWD forecast history, space weather indices, local sensors, and MIM weather.

- **Request Parameters**:
  - `start` (string, required): Start date/time in ISO 8601 format (e.g. `2026-06-01T00:00:00Z`).
  - `end` (string, required): End date/time in ISO 8601 format (e.g. `2026-06-08T23:59:59Z`).

- **Request**: `GET /api/history?start=2026-06-10T00:00:00Z&end=2026-06-11T00:00:00Z`
- **Response Format**:
```json
{
  "outdoor": [{"time": "2026-06-10T00:00:00Z", "val": 15.4}],
  "indoor": [{"time": "2026-06-10T00:00:00Z", "val": 20.1}],
  "forecast": [{"time": "2026-06-10T00:00:00Z", "val": 288.55}],
  "forecast_wwp": [{"time": "2026-06-10T00:00:00Z", "val": 0.0}],
  "forecast_sund": [{"time": "2026-06-10T00:00:00Z", "val": 60.0}],
  "additional": {
    "omu/enviro-master/GEIGER-1/sensor/frequency": [{"time": "2026-06-10T00:00:00Z", "val": 0.15}],
    "omu/enviro-master/BME280-1/sensor/pressureNN": [{"time": "2026-06-10T00:00:00Z", "val": 1018.5}]
  },
  "kp": [{"time": "2026-06-10T00:00:00Z", "val": 3.0}],
  "wind_speed": [{"time": "2026-06-10T00:00:00Z", "val": 450.2}],
  "wind_density": [{"time": "2026-06-10T00:00:00Z", "val": 5.4}],
  "imf_bt": [{"time": "2026-06-10T00:00:00Z", "val": 6.1}],
  "imf_bz": [{"time": "2026-06-10T00:00:00Z", "val": -1.2}],
  "mim_temp": [{"time": "2026-06-10T00:00:00Z", "val": 16.2}],
  "mim_humidity": [{"time": "2026-06-10T00:00:00Z", "val": 65.0}],
  "mim_wind_speed": [{"time": "2026-06-10T00:00:00Z", "val": 3.2}],
  "mim_wind_dir": [{"time": "2026-06-10T00:00:00Z", "val": 240.0}],
  "mim_global_rad": [{"time": "2026-06-10T00:00:00Z", "val": 320.0}],
  "mim_diffuse_rad": [{"time": "2026-06-10T00:00:00Z", "val": 85.0}],
  "mim_atm_rad": [{"time": "2026-06-10T00:00:00Z", "val": 340.0}]
}
```

#### Gap / Sensor Failure Sentinels
If a sensor goes offline, the database registers a sentinel row where the value `val` is explicitly `null`. Integrators should check for `val === null` to display gaps or handle outages appropriately.

---

### 2.4. GET `/api/status`
Exposes the runtime health and status details of all background pollers and MQTT connections. Helpful for diagnostic monitoring.

- **Request**: `GET /api/status`
- **Response Format**:
```json
{
  "sources": {
    "forecast": {
      "label": "DWD Forecast",
      "last_updated": 1781251200.0,
      "age_secs": 250.0,
      "interval_secs": 1800,
      "is_stale": false,
      "next_poll_in": 1550.0
    },
    "noaa": {
      "label": "NOAA Space Weather",
      "last_updated": 1781251000.0,
      "age_secs": 450.0,
      "interval_secs": 600,
      "is_stale": false,
      "next_poll_in": 150.0
    },
    "mim": {
      "label": "MIM Munich Weather",
      "last_updated": 1781250900.0,
      "age_secs": 550.0,
      "interval_secs": 900,
      "is_stale": false,
      "next_poll_in": 350.0
    }
  },
  "mqtt": {
    "omu/enviro-master/BME280-1/sensor/temperature": {
      "last_seen": 1781251440.0,
      "age_secs": 10.0,
      "is_stale": false,
      "stale_threshold_secs": 900,
      "group": "outdoor"
    }
  },
  "mqtt_stale_threshold_secs": 900
}
```

---

### 2.5. GET `/api/config`
Retrieves active system configurations, coordinates, station details, and server variables.

- **Request**: `GET /api/config`
- **Response Format**:
```json
{
  "station_id": "10865",
  "cache_expiry_secs": 3600,
  "forecast_min_interval_secs": 1800,
  "noaa_interval_secs": 600,
  "mim_interval_secs": 900,
  "mqtt_health_interval_secs": 60,
  "port": 8089,
  "host": "0.0.0.0"
}
```

---

### 2.6. POST `/api/log_error`
Accepts frontend errors and exceptions to log them on the server console and logger files.

- **Request**: `POST /api/log_error`
- **Payload Schema**:
```json
{
  "message": "Error description string",
  "source": "script_name.js",
  "lineno": 42,
  "colno": 5,
  "stack": "Stack trace text..."
}
```
- **Response**: `{"status": "ok"}`

---

## 3. Integration Examples

### Python Example
Fetch the current outdoor temperature from the MQTT sensor:

```python
import requests

BASE_URL = "http://nalanda:8089"

def get_current_outdoor_temp():
    try:
        response = requests.get(f"{BASE_URL}/api/forecast")
        response.raise_for_status()
        data = response.json()
        
        last_measurement = data.get("mqtt_last_measurement")
        if last_measurement and last_measurement.get("temp") is not None:
            print(f"Outdoor Temp: {last_measurement['temp']} °C (measured at {last_measurement['time']})")
        else:
            print("Outdoor temp is currently offline/unavailable.")
    except Exception as e:
        print(f"Error fetching weather data: {e}")

if __name__ == "__main__":
    get_current_outdoor_temp()
```

### Node-RED / JavaScript Example
Process historical data and filter out missing values/sensor outages:

```javascript
fetch("http://nalanda:8089/api/history?start=2026-06-10T00:00:00Z&end=2026-06-11T00:00:00Z")
  .then(res => res.json())
  .then(data => {
    const outdoorHistory = data.outdoor || [];
    
    // Process readings
    outdoorHistory.forEach(reading => {
      if (reading.val === null) {
        console.warn(`Sensor outage recorded at ${reading.time}`);
      } else {
        console.log(`Time: ${reading.time} -> Temp: ${reading.val.toFixed(1)} °C`);
      }
    });
  });
```
