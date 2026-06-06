import logging
import time
import json
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

class MQTTManager:
    def __init__(self, host: str, port: int, topic: str | list[str], cache_dir: Path = Path("cache"), history_filename: str = "mqtt_history.json", db: Database | None = None) -> None:
        self.host = host
        self.port = port
        self.topic = topic
        self.db = db
        self.last_temp: float | None = None
        self.last_time: float | None = None
        
        # Maps topic -> hour slot -> list of readings
        self._raw_readings: dict[str, dict[str, list[float]]] = {}
        # Maps topic -> hour slot -> average value
        self.history_multi: dict[str, dict[str, float]] = {}
        
        self.primary_topic = topic[0] if isinstance(topic, list) else topic
        self.history: dict[str, float] = {}
        self._raw_hourly: dict[str, list[float]] = {}
        
        self.history_file = cache_dir / history_filename
        self.lock = threading.Lock()
        
        self.client: mqtt.Client | None = None
        self.thread: threading.Thread | None = None

        self._load_history()

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
                "raw_readings": self._raw_readings
            }
            with open(self.history_file, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.warning(f"Failed to save MQTT history to disk: {e}")

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
            # Connect in a loop or let loop_start handle it.
            # loop_start handles reconnects automatically
            self.client.connect(self.host, self.port, keepalive=60)
            self.client.loop_start()
            logger.info("MQTT loop started successfully.")
        except Exception as e:
            logger.error(f"MQTT connection to {self.host} failed: {e}. Reconnect will be attempted automatically by paho-mqtt.")
            # If initial connection fails, we still run loop_start as it retries
            self.client.loop_start()

    def _on_connect(self, client: mqtt.Client, userdata: typing.Any, flags: dict[str, typing.Any], rc: int, properties: typing.Any = None) -> None:
        logger.info(f"MQTT connected with result code: {rc}")
        if isinstance(self.topic, list):
            for t in self.topic:
                client.subscribe(t)
                logger.info(f"Subscribed to topic: {t}")
        else:
            client.subscribe(self.topic)
            logger.info(f"Subscribed to topic: {self.topic}")

    def _on_message(self, client: mqtt.Client, userdata: typing.Any, msg: mqtt.MQTTMessage) -> None:
        try:
            payload = msg.payload.decode('utf-8').strip()
            val = float(payload)
            self.add_measurement(msg.topic, val)
        except ValueError:
            logger.warning(f"MQTT received invalid float payload on {msg.topic}: {msg.payload}")
        except Exception as e:
            logger.error(f"Error handling MQTT message: {e}")

    def add_measurement(self, topic: str, val: float) -> None:
        with self.lock:
            now = datetime.now(timezone.utc)
            if topic == self.primary_topic:
                self.last_temp = val
                self.last_time = now.timestamp()
            
            # Format slot as "YYYY-MM-DDTHH:MM:00.000Z" (ISO 10-minute slot)
            minute_slot = (now.minute // 10) * 10
            slot = now.replace(minute=minute_slot, second=0, microsecond=0).strftime("%Y-%m-%dT%H:%M:00.000Z")
            
            # Multi-topic tracking
            if topic not in self._raw_readings:
                self._raw_readings[topic] = {}
            if slot not in self._raw_readings[topic]:
                self._raw_readings[topic][slot] = []
            self._raw_readings[topic][slot].append(val)
            
            if topic not in self.history_multi:
                self.history_multi[topic] = {}
                
            avg_val = sum(self._raw_readings[topic][slot]) / len(self._raw_readings[topic][slot])
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
                # Metric name is the last component of the MQTT topic
                metric = topic.split('/')[-1]
                self.db.insert_sensor_reading(slot, topic, metric, avg_val)
                
            self._save_history()
            logger.debug(f"Added MQTT reading: {val} for topic {topic} slot {slot}")

    def get_data(self) -> dict[str, typing.Any]:
        with self.lock:
            return {
                "last_measurement": {
                    "temp": self.last_temp,
                    "time": self.last_time
                } if self.last_temp is not None else None,
                "history": self.history
            }
