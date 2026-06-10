import logging
import time
import json
import atexit
from pathlib import Path
from datetime import datetime, timezone
import threading
import typing
try:
    from paho.mqtt.enums import CallbackAPIVersion
    has_v2_api = True
except ImportError:
    has_v2_api = False
import paho.mqtt.client as mqtt
from dwd_server.database import Database

logger = logging.getLogger("dwd_server.mqtt")

# Default stale threshold: 15 minutes without a message → topic considered unavailable
DEFAULT_STALE_THRESHOLD_SECS: float = 900.0


class MQTTManager:
    def __init__(
        self,
        host: str,
        port: int,
        topic: str | list[str],
        cache_dir: Path = Path("cache"),
        history_filename: str = "mqtt_history.json",
        db: Database | None = None,
        stale_threshold_secs: float = DEFAULT_STALE_THRESHOLD_SECS,
    ) -> None:
        self.host = host
        self.port = port
        self.topic = topic
        self.db = db
        self.stale_threshold_secs = stale_threshold_secs

        self.last_temp: float | None = None
        self.last_time: float | None = None

        # Maps topic -> hour slot -> list of readings
        self._raw_readings: dict[str, dict[str, list[float]]] = {}
        # Maps topic -> hour slot -> average value
        self.history_multi: dict[str, dict[str, float]] = {}

        self.primary_topic = topic[0] if isinstance(topic, list) else topic
        self.history: dict[str, float] = {}
        self._raw_hourly: dict[str, list[float]] = {}

        # Per-topic last-seen timestamp (Unix epoch float), None = never seen
        self._last_seen: dict[str, float | None] = {}

        # Track all expected topics so we can detect ones that never sent data
        if isinstance(topic, list):
            for t in topic:
                self._last_seen[t] = None
        else:
            self._last_seen[topic] = None

        self.history_file = cache_dir / history_filename
        self.lock = threading.Lock()

        self.client: mqtt.Client | None = None
        self.thread: threading.Thread | None = None

        self._last_save_time: float = 0.0
        self._last_saved_slot: str | None = None
        self._load_history()
        atexit.register(self._save_history)

    # -----------------------------------------------------------------------
    # Persistence
    # -----------------------------------------------------------------------

    def _load_history(self) -> None:
        if not self.history_file.is_file():
            return
        try:
            with open(self.history_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                self.history = data.get("history", {})
                self._raw_hourly = data.get("raw_hourly", {})
                self.last_temp = data.get("last_temp")
                self.last_time = data.get("last_time")
                self.history_multi = data.get("history_multi", {})
                self._raw_readings = data.get("raw_readings", {})
                # Restore last-seen timestamps (may be absent in older cache files)
                persisted_last_seen: dict[str, float | None] = data.get("last_seen", {})
                for t in self._last_seen:
                    if t in persisted_last_seen:
                        self._last_seen[t] = persisted_last_seen[t]
            logger.info(f"Loaded MQTT history with {len(self.history)} 10-minute slots.")
        except Exception as e:
            logger.warning(f"Failed to load MQTT history from disk: {e}")

    def _save_history(self) -> None:
        try:
            self.history_file.parent.mkdir(parents=True, exist_ok=True)
            data = {
                "history": self.history,
                "raw_hourly": self._raw_hourly,
                "last_temp": self.last_temp,
                "last_time": self.last_time,
                "history_multi": self.history_multi,
                "raw_readings": self._raw_readings,
                "last_seen": self._last_seen,
            }
            with open(self.history_file, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.warning(f"Failed to save MQTT history to disk: {e}")

    # -----------------------------------------------------------------------
    # MQTT networking
    # -----------------------------------------------------------------------

    def start(self) -> None:
        if not self.host:
            logger.info("MQTT host is not configured. Local measurements disabled.")
            return
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self) -> None:
        logger.info(f"Starting MQTT client, connecting to {self.host}:{self.port}...")
        if has_v2_api:
            self.client = mqtt.Client(callback_api_version=CallbackAPIVersion.VERSION2)
        else:
            self.client = mqtt.Client()
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message

        try:
            self.client.connect_async(self.host, self.port, keepalive=60)
            self.client.loop_start()
            logger.info("MQTT loop started successfully.")
        except Exception as e:
            logger.error(
                f"MQTT connection setup failed: {e}"
            )

    def _on_connect(
        self,
        client: mqtt.Client,
        userdata: typing.Any,
        flags: dict[str, typing.Any],
        rc: int,
        properties: typing.Any = None,
    ) -> None:
        logger.info(f"MQTT connected with result code: {rc}")
        if isinstance(self.topic, list):
            for t in self.topic:
                client.subscribe(t)
                logger.info(f"Subscribed to topic: {t}")
        else:
            client.subscribe(self.topic)
            logger.info(f"Subscribed to topic: {self.topic}")

    def _on_message(
        self, client: mqtt.Client, userdata: typing.Any, msg: mqtt.MQTTMessage
    ) -> None:
        try:
            payload = msg.payload.decode("utf-8").strip()
            val = float(payload)
            self.add_measurement(msg.topic, val)
        except ValueError:
            logger.warning(
                f"MQTT received invalid float payload on {msg.topic}: {msg.payload}"
            )
        except Exception as e:
            logger.error(f"Error handling MQTT message: {e}")

    # -----------------------------------------------------------------------
    # Measurement handling
    # -----------------------------------------------------------------------

    def add_measurement(self, topic: str, val: float) -> None:
        with self.lock:
            now = datetime.now(timezone.utc)
            now_ts = now.timestamp()

            if topic == self.primary_topic:
                self.last_temp = val
                self.last_time = now_ts

            # Update per-topic last-seen
            self._last_seen[topic] = now_ts

            # Format slot as "YYYY-MM-DDTHH:MM:00.000Z" (ISO 10-minute slot)
            minute_slot = (now.minute // 10) * 10
            slot = now.replace(minute=minute_slot, second=0, microsecond=0).strftime(
                "%Y-%m-%dT%H:%M:00.000Z"
            )

            # Multi-topic tracking
            if topic not in self._raw_readings:
                self._raw_readings[topic] = {}
            if slot not in self._raw_readings[topic]:
                self._raw_readings[topic][slot] = []
            self._raw_readings[topic][slot].append(val)

            if topic not in self.history_multi:
                self.history_multi[topic] = {}

            avg_val = (
                sum(self._raw_readings[topic][slot])
                / len(self._raw_readings[topic][slot])
            )
            self.history_multi[topic][slot] = avg_val

            # Sync to primary single-topic properties for backward compatibility
            if topic == self.primary_topic:
                self.history[slot] = avg_val
                self._raw_hourly[slot] = self._raw_readings[topic][slot]

            # Limit history_multi[topic] to 288 slots (48 hours)
            if len(self.history_multi[topic]) > 288:
                sorted_slots = sorted(self.history_multi[topic].keys())
                while len(self.history_multi[topic]) > 288:
                    old_slot = sorted_slots.pop(0)
                    self.history_multi[topic].pop(old_slot, None)
                    self._raw_readings[topic].pop(old_slot, None)

            # Sync limits back to primary single-topic properties
            if topic == self.primary_topic:
                self.history = self.history_multi[topic]
                self._raw_hourly = self._raw_readings[topic]

            if self.db:
                metric = topic.split("/")[-1]
                self.db.insert_sensor_reading(slot, topic, metric, avg_val)

            # Throttle disk writes to at most once per 60 seconds, or on slot change
            if (
                self._last_save_time == 0.0
                or now_ts - self._last_save_time >= 60.0
                or slot != self._last_saved_slot
            ):
                self._save_history()
                self._last_save_time = now_ts
                self._last_saved_slot = slot

            logger.debug(f"Added MQTT reading: {val} for topic {topic} slot {slot}")

    # -----------------------------------------------------------------------
    # Stale detection & null-sentinel injection
    # -----------------------------------------------------------------------

    def get_topic_statuses(self) -> dict[str, dict[str, typing.Any]]:
        """Return health status for every monitored topic.

        Returns a dict keyed by topic with:
            last_seen: float | None   — Unix timestamp of last message, or None
            age_secs:  float | None   — seconds since last message, or None if never seen
            is_stale:  bool           — True if age > stale_threshold or never seen
        """
        now = time.time()
        statuses: dict[str, dict[str, typing.Any]] = {}
        with self.lock:
            for topic, last_seen in self._last_seen.items():
                if last_seen is None:
                    age = None
                    stale = True
                else:
                    age = now - last_seen
                    stale = age > self.stale_threshold_secs
                statuses[topic] = {
                    "last_seen": last_seen,
                    "age_secs": age,
                    "is_stale": stale,
                }
        return statuses

    def inject_stale_sentinels(self) -> None:
        """Insert null DB sentinels for every topic that has gone stale.

        Called periodically by the background scheduler so the time-series
        shows an explicit gap when sensors stop sending.
        """
        if not self.db:
            return
        now = datetime.now(timezone.utc)
        minute_slot = (now.minute // 10) * 10
        slot = now.replace(minute=minute_slot, second=0, microsecond=0).strftime(
            "%Y-%m-%dT%H:%M:00.000Z"
        )
        statuses = self.get_topic_statuses()
        sentinels: list[tuple[str, str, str, float | None]] = []
        for topic, s in statuses.items():
            if s["is_stale"]:
                metric = topic.split("/")[-1]
                sentinels.append((slot, topic, metric, None))
                age_str = (
                    f"{s['age_secs']:.0f}s ago"
                    if s["age_secs"] is not None
                    else "never"
                )
                logger.info(
                    f"[mqtt-health] Topic '{topic}' is stale (last seen: {age_str})"
                    f" — inserting null sentinel at {slot}."
                )
        if sentinels:
            self.db.insert_sensor_readings(sentinels)

    # -----------------------------------------------------------------------
    # Data access
    # -----------------------------------------------------------------------

    def get_data(self) -> dict[str, typing.Any]:
        with self.lock:
            return {
                "last_measurement": (
                    {"temp": self.last_temp, "time": self.last_time}
                    if self.last_temp is not None
                    else None
                ),
                "history": self.history,
            }
