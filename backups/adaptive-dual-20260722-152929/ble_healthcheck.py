#!/usr/bin/env python3
"""Healthcheck for the BLE data plane, not only the gateway process."""
import json
import os
import sys
import time
from pathlib import Path

path = Path(os.getenv("BLE_HEALTH_FILE", "/tmp/nurseaid-ble-health.json"))
max_age = max(15, int(os.getenv("BLE_HEALTH_MAX_AGE_SECONDS", "45")))

try:
    state = json.loads(path.read_text(encoding="utf-8"))
    heartbeat = float(state.get("controllerHeartbeat") or state.get("timestamp") or 0)
    healthy = bool(state.get("scannerHealthy")) and time.time() - heartbeat <= max_age
except (OSError, ValueError, TypeError, json.JSONDecodeError):
    healthy = False

sys.exit(0 if healthy else 1)