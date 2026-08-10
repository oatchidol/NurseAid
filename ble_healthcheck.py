#!/usr/bin/env python3
"""Healthcheck for the BLE data plane, not only the gateway process."""
import json
import os
import sys
import time
from pathlib import Path

def is_healthy(path: Path, max_age: int, now: float | None = None) -> bool:
    """Require gateway heartbeat and a working BLE data plane."""
    now = time.time() if now is None else now
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
        heartbeat = float(state.get("controllerHeartbeat") or state.get("timestamp") or 0)
        return (
            bool(state.get("scannerHealthy"))
            and state.get("status") != "unhealthy"
            and now - heartbeat <= max_age
        )
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return False


if __name__ == "__main__":
    path = Path(os.getenv("BLE_HEALTH_FILE", "/tmp/nurseaid-ble-health.json"))
    max_age = max(15, int(os.getenv("BLE_HEALTH_MAX_AGE_SECONDS", "45")))
    sys.exit(0 if is_healthy(path, max_age) else 1)