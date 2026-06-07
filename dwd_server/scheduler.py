"""Background scheduler for independent per-source data polling."""

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field

logger = logging.getLogger("dwd_server.scheduler")


@dataclass
class ScheduledTask:
    name: str
    fn: Callable[[], None]
    interval_secs: float
    last_run: float = field(default=0.0)


class BackgroundScheduler:
    """
    Runs multiple tasks in a single daemon thread, each on its own interval.
    Each task fires immediately on the first scheduler tick after startup.
    Tasks are independent — a slow or failing task does not delay others.
    """

    def __init__(self, tasks: list[ScheduledTask], tick_secs: float = 10.0) -> None:
        self._tasks = tasks
        self._tick_secs = tick_secs
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run_loop, daemon=True, name="BackgroundScheduler")
        self._thread.start()
        logger.info(f"BackgroundScheduler started with {len(self._tasks)} task(s): "
                    f"{[t.name for t in self._tasks]}")

    def get_status(self) -> dict[str, dict[str, float]]:
        """Return last_run and interval_secs for each registered task."""
        return {
            task.name: {
                "last_run": task.last_run,       # monotonic time — 0.0 if never run
                "interval_secs": task.interval_secs,
            }
            for task in self._tasks
        }

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=30)
            self._thread = None
        logger.info("BackgroundScheduler stopped.")

    def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            now = time.monotonic()
            for task in self._tasks:
                elapsed = now - task.last_run
                if elapsed >= task.interval_secs:
                    task.last_run = now
                    self._run_task(task)
            self._stop_event.wait(timeout=self._tick_secs)

    def _run_task(self, task: ScheduledTask) -> None:
        t_start = time.monotonic()
        logger.info(f"[scheduler] Running task '{task.name}' (interval={task.interval_secs:.0f}s)")
        try:
            task.fn()
            elapsed = time.monotonic() - t_start
            logger.info(f"[scheduler] Task '{task.name}' completed in {elapsed:.2f}s")
        except Exception as exc:
            elapsed = time.monotonic() - t_start
            logger.error(f"[scheduler] Task '{task.name}' failed after {elapsed:.2f}s: {exc}", exc_info=True)
