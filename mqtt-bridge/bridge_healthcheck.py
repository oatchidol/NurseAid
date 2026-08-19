#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path

path = Path(os.getenv("MQTT_BRIDGE_HEALTH_FILE", "/tmp/nurseaid-mqtt-bridge-health.json"))
try:
    state = json.loads(path.read_text(encoding="utf-8"))
    healthy = bool(state.get("healthy")) and time.time() - float(state.get("timestamp", 0)) <= 15
except (OSError, ValueError, TypeError, json.JSONDecodeError):
    healthy = False
sys.exit(0 if healthy else 1)