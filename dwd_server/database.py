import sqlite3
from pathlib import Path
import logging
from typing import Any

logger = logging.getLogger("dwd_server.database")

class Database:
    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.init_db()

    def _get_conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        return conn

    def init_db(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._get_conn() as conn:
            # Enable WAL mode for better write/read concurrency
            conn.execute("PRAGMA journal_mode=WAL;")

            # Create sensor_readings table.
            # `value` is REAL and nullable — NULL represents an explicit "data
            # unavailable" sentinel inserted by the scheduler on fetch failure,
            # which the frontend renders as a line-break gap (no interpolation).
            conn.execute("""
                CREATE TABLE IF NOT EXISTS sensor_readings (
                    timestamp TEXT NOT NULL,
                    sensor_id TEXT NOT NULL,
                    metric TEXT NOT NULL,
                    value REAL,
                    PRIMARY KEY (timestamp, sensor_id, metric)
                );
            """)

            # Create forecast_history table
            conn.execute("""
                CREATE TABLE IF NOT EXISTS forecast_history (
                    timestamp TEXT NOT NULL,
                    station_id TEXT NOT NULL,
                    metric TEXT NOT NULL,
                    value REAL NOT NULL,
                    PRIMARY KEY (timestamp, station_id, metric)
                );
            """)

            # Migrate existing DB: drop NOT NULL constraint on sensor_readings.value
            # SQLite does not support ALTER COLUMN, so we detect old schema via
            # PRAGMA table_info and rebuild if necessary.
            cursor = conn.execute("PRAGMA table_info(sensor_readings);")
            cols = {row["name"]: row for row in cursor.fetchall()}
            value_col = cols.get("value")
            if value_col is not None and value_col["notnull"] == 1:
                logger.info("Migrating sensor_readings: dropping NOT NULL on value column...")
                conn.execute("ALTER TABLE sensor_readings RENAME TO sensor_readings_old;")
                conn.execute("""
                    CREATE TABLE sensor_readings (
                        timestamp TEXT NOT NULL,
                        sensor_id TEXT NOT NULL,
                        metric TEXT NOT NULL,
                        value REAL,
                        PRIMARY KEY (timestamp, sensor_id, metric)
                    );
                """)
                conn.execute("""
                    INSERT INTO sensor_readings
                    SELECT timestamp, sensor_id, metric, value
                    FROM sensor_readings_old;
                """)
                conn.execute("DROP TABLE sensor_readings_old;")
                logger.info("Migration complete.")

            # Create indices to speed up range queries
            conn.execute("CREATE INDEX IF NOT EXISTS idx_sensor_readings_query ON sensor_readings (sensor_id, metric, timestamp);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_forecast_history_query ON forecast_history (station_id, metric, timestamp);")

            conn.commit()
        logger.info(f"Database initialized at {self.db_path}")

    def insert_sensor_reading(self, timestamp: str, sensor_id: str, metric: str, value: float | None) -> None:
        try:
            with self._get_conn() as conn:
                conn.execute("""
                    INSERT OR REPLACE INTO sensor_readings (timestamp, sensor_id, metric, value)
                    VALUES (?, ?, ?, ?);
                """, (timestamp, sensor_id, metric, value))
                conn.commit()
        except Exception as e:
            logger.error(f"Failed to insert sensor reading: {e}")

    def insert_sensor_readings(self, readings: list[tuple[str, str, str, float | None]]) -> None:
        if not readings:
            return
        try:
            with self._get_conn() as conn:
                conn.executemany("""
                    INSERT OR REPLACE INTO sensor_readings (timestamp, sensor_id, metric, value)
                    VALUES (?, ?, ?, ?);
                """, readings)
                conn.commit()
        except Exception as e:
            logger.error(f"Failed to insert sensor readings: {e}")

    def insert_forecast_readings(self, station_id: str, timesteps: list[str], elements: dict[str, list[float | None]]) -> None:
        try:
            with self._get_conn() as conn:
                for metric, values in elements.items():
                    for ts, val in zip(timesteps, values):
                        if val is not None:
                            conn.execute("""
                                INSERT OR REPLACE INTO forecast_history (timestamp, station_id, metric, value)
                                VALUES (?, ?, ?, ?);
                            """, (ts, station_id, metric, val))
                conn.commit()
        except Exception as e:
            logger.error(f"Failed to insert forecast readings: {e}")

    def get_sensor_history(self, sensor_id: str, metric: str, start: str, end: str) -> list[dict[str, Any]]:
        """Return timestamped readings including NULL sentinels (val=None) for gaps."""
        try:
            with self._get_conn() as conn:
                cursor = conn.execute("""
                    SELECT timestamp as time, value as val
                    FROM sensor_readings
                    WHERE sensor_id = ? AND metric = ? AND timestamp >= ? AND timestamp <= ?
                    ORDER BY timestamp ASC;
                """, (sensor_id, metric, start, end))
                return [dict(row) for row in cursor.fetchall()]
        except Exception as e:
            logger.error(f"Failed to get sensor history: {e}")
            return []

    def get_forecast_history(self, station_id: str, metric: str, start: str, end: str) -> list[dict[str, Any]]:
        try:
            with self._get_conn() as conn:
                cursor = conn.execute("""
                    SELECT timestamp as time, value as val
                    FROM forecast_history
                    WHERE station_id = ? AND metric = ? AND timestamp >= ? AND timestamp <= ?
                    ORDER BY timestamp ASC;
                """, (station_id, metric, start, end))
                return [dict(row) for row in cursor.fetchall()]
        except Exception as e:
            logger.error(f"Failed to get forecast history: {e}")
            return []
