#!/usr/bin/env python3
"""
NurseAid BLE Gateway — Unified BLE Central Gateway
===================================================
Reads device MAC addresses from PostgreSQL (nurseaid table) dynamically.
Scans, connects, and reads vitals from NurseAid wearable devices.
Publishes vitals to MQTT in unified format compatible with nurseaid_ble_server.py.

Usage:
    export DB_HOST=localhost
    export DB_PORT=5432
    export DB_NAME=softwatch_iot
    export DB_USER=postgres
    export DB_PASSWORD=...
    export MQTT_HOST=localhost
    export MQTT_PORT=1883
    export MQTT_USER=
    export MQTT_PASSWORD=
    export BLE_REQUIRE_PAIRED=true
    export BLE_DEVICE_SYNC_INTERVAL=30

    python3 nurseaid_ble_gateway.py
"""

import os
import sys
import json
import time
import uuid
import signal
import asyncio
import re
import statistics
import threading
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any

from ble_adapter_manager import (
    AdaptiveAdapterManager, AdapterRuntime, normalize_address,
    parse_hciconfig_inventory,
)

import paho.mqtt.client as mqtt

from sensor_drivers import (
    DRIVER_MODE_ADVERTISEMENT,
    DRIVER_MODE_EXTERNAL,
    DRIVER_MODE_JSTYLE,
    DRIVER_MODE_STANDARD_GATT,
    DRIVER_MODE_UNSUPPORTED,
    DRIVER_MODE_WEAROS,
    DRIVER_REGISTRY,
    StandardGATTDeviceHandler,
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True)
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(line_buffering=True)

# Try to import bleak and psycopg2, provide helpful error if missing
try:
    from bleak import BleakScanner, BleakError, BleakClient
    # BleakDevice was removed in bleak 3.0, use object type hint instead
    BleakDevice = object
except ImportError:
    print("ERROR: bleak library not installed. Run: pip install bleak>=0.22")
    sys.exit(1)

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("ERROR: psycopg2 library not installed. Run: pip install psycopg2-binary>=2.9")
    sys.exit(1)


# ============================================================
# CONFIGURATION — read from environment variables
# ============================================================

def _env_int(key: str, default: int) -> int:
    try:
        return int(os.getenv(key, str(default)))
    except (ValueError, TypeError):
        return default


def _env_float(key: str, default: float) -> float:
    try:
        return float(os.getenv(key, str(default)))
    except (ValueError, TypeError):
        return default


def _env_str(key: str, default: str) -> str:
    return os.getenv(key, default) or default


def _env_bool(key: str, default: bool) -> bool:
    val = os.getenv(key, "").lower()
    if val in ("true", "1", "yes", "on"):
        return True
    if val in ("false", "0", "no", "off"):
        return False
    return default


# --- PostgreSQL ---
DB_HOST = _env_str("DB_HOST", "localhost")
DB_PORT = _env_int("DB_PORT", 5432)
DB_NAME = _env_str("DB_NAME", "softwatch_iot")
DB_USER = _env_str("DB_USER", "postgres")
DB_PASSWORD = _env_str("DB_PASSWORD", "")

# --- MQTT ---
MQTT_HOST = _env_str("MQTT_HOST", "localhost")
MQTT_PORT = _env_int("MQTT_PORT", 1883)
MQTT_USER = _env_str("MQTT_USER", "")
MQTT_PASSWORD = _env_str("MQTT_PASSWORD", "")

# --- BLE ---
# "Paired" here means assigned to a patient in the nurseaid table. It is
# unrelated to BlueZ's operating-system-level Bluetooth pairing state.
BLE_REQUIRE_PAIRED = _env_bool("BLE_REQUIRE_PAIRED", True)
BLE_DEVICE_SYNC_INTERVAL = _env_int("BLE_DEVICE_SYNC_INTERVAL", 30)
BLE_CONNECT_TIMEOUT = max(1.0, _env_float("BLE_CONNECT_TIMEOUT", 20.0))
BLE_CONNECT_CLEANUP_TIMEOUT = max(
    1.0, _env_float("BLE_CONNECT_CLEANUP_TIMEOUT", 5.0)
)
BLE_RSSI_MIN_THRESHOLD = _env_int("BLE_RSSI_MIN_THRESHOLD", -85)
BLE_SCAN_TIMEOUT = _env_int("BLE_SCAN_TIMEOUT", 10)
BLE_CONNECT_RETRY_MAX = _env_int("BLE_CONNECT_RETRY_MAX", 3)
BLE_CONNECT_RETRY_DELAY = _env_float("BLE_CONNECT_RETRY_DELAY", 2.0)
BLE_JSTYLE_ATTEMPTS_PER_TURN = max(1, _env_int("BLE_JSTYLE_ATTEMPTS_PER_TURN", 1))
BLE_RETRY_BACKOFF_BASE = max(1.0, _env_float("BLE_RETRY_BACKOFF_BASE", 15.0))
BLE_RETRY_BACKOFF_MAX = max(BLE_RETRY_BACKOFF_BASE, _env_float("BLE_RETRY_BACKOFF_MAX", 120.0))
BLE_CONNECT_CANDIDATE_MAX_AGE = max(1.0, _env_float("BLE_CONNECT_CANDIDATE_MAX_AGE", 8.0))
BLE_REDISCOVERY_TIMEOUT = max(1.0, _env_float("BLE_REDISCOVERY_TIMEOUT", 8.0))
GATT_SETUP_TIMEOUT = _env_float("GATT_SETUP_TIMEOUT", 15.0)
BLE_STALE_THRESHOLD = _env_int("BLE_STALE_THRESHOLD", 30)
BLE_CACHE_CHECK_INTERVAL = _env_int("BLE_CACHE_CHECK_INTERVAL", 5)
BLE_SCAN_DURING_WEAROS = _env_bool("BLE_SCAN_DURING_WEAROS", True)
BLE_SCANNER_STALE_SECONDS = max(30, _env_int("BLE_SCANNER_STALE_SECONDS", 90))
BLE_SCANNER_IDLE_RESTART_SECONDS = max(
    BLE_SCANNER_STALE_SECONDS,
    _env_int("BLE_SCANNER_IDLE_RESTART_SECONDS", 900),
)
BLE_HEALTH_FILE = Path(_env_str("BLE_HEALTH_FILE", "/tmp/nurseaid-ble-health.json"))
BLE_OPERATIONAL_LOG_INTERVAL = max(30, _env_int("BLE_OPERATIONAL_LOG_INTERVAL", 60))
BLE_MAX_GATT_CONNECTIONS = max(1, _env_int("BLE_MAX_GATT_CONNECTIONS", 2))
BLE_RESERVED_WEAROS_SLOTS = min(
    BLE_MAX_GATT_CONNECTIONS,
    max(0, _env_int("BLE_RESERVED_WEAROS_SLOTS", 1)),
)
BLE_DUAL_ADAPTER_MODE = _env_str("BLE_DUAL_ADAPTER_MODE", "adaptive").lower()
BLE_ADAPTER_ADDRESSES = tuple(
    normalize_address(item)
    for item in _env_str("BLE_ADAPTER_ADDRESSES", "").split(",")
    if normalize_address(item)
)
BLE_AFFINITY_LEASE_SECONDS = max(60, _env_int("BLE_AFFINITY_LEASE_SECONDS", 1800))
BLE_AFFINITY_SWITCH_MARGIN = max(0.0, _env_float("BLE_AFFINITY_SWITCH_MARGIN", 25.0))
BLE_MAX_GATT_CONNECTIONS_PER_ADAPTER = max(
    1, _env_int("BLE_MAX_GATT_CONNECTIONS_PER_ADAPTER", 2)
)
BLE_MAX_ACTIVE_MEASUREMENTS_PER_ADAPTER = max(
    1, _env_int("BLE_MAX_ACTIVE_MEASUREMENTS_PER_ADAPTER", 1)
)
BLE_SCANNER_RECOVERY_COOLDOWN_SECONDS = max(
    BLE_SCANNER_STALE_SECONDS,
    _env_int("BLE_SCANNER_RECOVERY_COOLDOWN_SECONDS", 120),
)
BLE_SCANNER_START_TIMEOUT_SECONDS = max(
    5.0, _env_float("BLE_SCANNER_START_TIMEOUT_SECONDS", 15.0)
)
WEAROS_RX_BUFFER_MAX_BYTES = max(
    512, _env_int("WEAROS_RX_BUFFER_MAX_BYTES", 4096)
)
WEAROS_RX_BUFFER_TIMEOUT_SECONDS = max(
    1.0, _env_float("WEAROS_RX_BUFFER_TIMEOUT_SECONDS", 5.0)
)
WEAROS_MAX_CONSECUTIVE_PARSE_ERRORS = max(
    2, _env_int("WEAROS_MAX_CONSECUTIVE_PARSE_ERRORS", 3)
)
WEAROS_PARSE_ERROR_LOG_INTERVAL = max(
    10.0, _env_float("WEAROS_PARSE_ERROR_LOG_INTERVAL", 60.0)
)

# --- Protocol Timing ---
PHASE_1_DURATION = max(15, _env_int("PHASE_1_DURATION", 35))
PHASE_1_MIN_DURATION = max(5, min(PHASE_1_DURATION, _env_int("PHASE_1_MIN_DURATION", 15)))
PHASE_1_STABLE_SAMPLES = max(1, _env_int("PHASE_1_STABLE_SAMPLES", 3))
PHASE_1_HR_TOLERANCE = max(0, _env_int("PHASE_1_HR_TOLERANCE", 6))
PHASE_1_TEMP_TOLERANCE = max(0.0, _env_float("PHASE_1_TEMP_TOLERANCE", 0.3))
PHASE_2_TIMEOUT = max(20, _env_int("PHASE_2_TIMEOUT", 45))
SPO2_NO_PROGRESS_TIMEOUT = max(
    10,
    min(PHASE_2_TIMEOUT, _env_int("SPO2_NO_PROGRESS_TIMEOUT", 35)),
)
KEEPALIVE_INTERVAL = _env_int("KEEPALIVE_INTERVAL", 30)
RSSI_READ_INTERVAL = _env_int("RSSI_READ_INTERVAL", 30)
BATTERY_READ_INTERVAL = _env_int("BATTERY_READ_INTERVAL", 60)
JSTYLE_ENABLE_MEASURE_COMMANDS = _env_bool("JSTYLE_ENABLE_MEASURE_COMMANDS", True)
JSTYLE_DEBUG_UNPARSED = _env_bool("JSTYLE_DEBUG_UNPARSED", False)
JSTYLE_VERBOSE_SENSOR_LOGS = _env_bool("JSTYLE_VERBOSE_SENSOR_LOGS", False)
JSTYLE_PUBLISH_ADVERTISEMENT = _env_bool("JSTYLE_PUBLISH_ADVERTISEMENT", True)
JSTYLE_CONNECT_FOR_GATT = _env_bool("JSTYLE_CONNECT_FOR_GATT", False)
JSTYLE_PHASE_WATCHDOG_GRACE = _env_int("JSTYLE_PHASE_WATCHDOG_GRACE", 15)
JSTYLE_OFF_WRIST_CONFIRMATIONS = max(2, _env_int("JSTYLE_OFF_WRIST_CONFIRMATIONS", 3))
JSTYLE_OFF_WRIST_MIN_CONFIRMATION_SECONDS = max(
    0.0, _env_float("JSTYLE_OFF_WRIST_MIN_CONFIRMATION_SECONDS", 2.0)
)
JSTYLE_OFF_WRIST_CONFIRMATION_WINDOW = max(
    30.0, _env_float("JSTYLE_OFF_WRIST_CONFIRMATION_WINDOW", 300.0)
)
JSTYLE_OFF_WRIST_PROBE_INTERVAL = max(
    30.0, _env_float("JSTYLE_OFF_WRIST_PROBE_INTERVAL", 90.0)
)
JSTYLE_WEAR_PROBE_TIMEOUT = max(
    5.0, _env_float("JSTYLE_WEAR_PROBE_TIMEOUT", 12.0)
)
JSTYLE_FIRST_SAMPLE_TIMEOUT = max(
    5.0, _env_float("JSTYLE_FIRST_SAMPLE_TIMEOUT", 12.0)
)
JSTYLE_FIRST_SAMPLE_RETRIES = max(
    0, _env_int("JSTYLE_FIRST_SAMPLE_RETRIES", 2)
)
JSTYLE_FIRST_SAMPLE_RETRY_DELAY = max(
    0.0, _env_float("JSTYLE_FIRST_SAMPLE_RETRY_DELAY", 2.0)
)
JSTYLE_COMMAND_RETRIES = max(0, _env_int("JSTYLE_COMMAND_RETRIES", 1))
JSTYLE_COMMAND_RETRY_DELAY = max(
    0.0, _env_float("JSTYLE_COMMAND_RETRY_DELAY", 0.5)
)
JSTYLE_SPO2_STREAM_RETRIES = max(
    0, _env_int("JSTYLE_SPO2_STREAM_RETRIES", 1)
)
JSTYLE_SPO2_RETRY_DELAY = max(
    0.0, _env_float("JSTYLE_SPO2_RETRY_DELAY", 2.0)
)
JSTYLE_STARTUP_OFF_WRIST_GRACE = max(
    0.0, _env_float("JSTYLE_STARTUP_OFF_WRIST_GRACE", 30.0)
)
JSTYLE_OFF_WRIST_SUSPECT_RETRY = max(
    10.0, _env_float("JSTYLE_OFF_WRIST_SUSPECT_RETRY", 30.0)
)
JSTYLE_CYCLES_PER_CONNECTION = max(1, _env_int("JSTYLE_CYCLES_PER_CONNECTION", 1))
JSTYLE_ROTATION_COOLDOWN = max(0.0, _env_float("JSTYLE_ROTATION_COOLDOWN", 5.0))
JSTYLE_PERSISTENT_STREAMING = _env_bool("JSTYLE_PERSISTENT_STREAMING", True)
JSTYLE_SPO2_RESTART_DELAY = max(0.0, _env_float("JSTYLE_SPO2_RESTART_DELAY", 1.0))

# --- JStyle SpO2 quality gate ---
SPO2_LOW_THRESHOLD = _env_int("SPO2_LOW_THRESHOLD", 95)
SPO2_SAMPLES_REQUIRED = max(3, _env_int("SPO2_SAMPLES_REQUIRED", 5))
SPO2_MIN_INLIERS = min(
    SPO2_SAMPLES_REQUIRED,
    max(3, _env_int("SPO2_MIN_INLIERS", 4)),
)
SPO2_SAMPLE_TOLERANCE = max(0, _env_int("SPO2_SAMPLE_TOLERANCE", 2))
SPO2_HR_TOLERANCE = max(0, _env_int("SPO2_HR_TOLERANCE", 12))
SPO2_WARMUP_SAMPLES = max(0, _env_int("SPO2_WARMUP_SAMPLES", 3))
SPO2_SENSOR_SETTLE_SECONDS = max(0.0, _env_float("SPO2_SENSOR_SETTLE_SECONDS", 3.0))

# --- Watchdog ---
WATCHDOG_INTERVAL = _env_int("WATCHDOG_INTERVAL", 30)
DATA_RECEIVE_TIMEOUT = _env_int("DATA_RECEIVE_TIMEOUT", 45)
WEAROS_NOTIFICATION_INTERVAL = _env_int("WEAROS_NOTIFICATION_INTERVAL", 60)
WEAROS_RECONNECT_COOLDOWN = max(15.0, _env_float("WEAROS_RECONNECT_COOLDOWN", 60.0))
MQTT_PUBLISH_INTERVAL = _env_int("MQTT_PUBLISH_INTERVAL", 1)

# --- SLA freshness targets (scheduler priority) ---
SLA_HR_SECONDS = max(30, _env_int("SLA_HR_SECONDS", 120))
SLA_SPO2_SECONDS = max(60, _env_int("SLA_SPO2_SECONDS", 600))
SLA_TEMP_SECONDS = max(60, _env_int("SLA_TEMP_SECONDS", 600))

# --- GATT Characteristic UUIDs (NurseAid Wear OS Peripheral / GATT Server) ---
CHAR_TX = "0000fff6-0000-1000-8000-00805f9b34fb"
CHAR_RX = "0000fff7-0000-1000-8000-00805f9b34fb"


def build_jstyle_command(*values: int) -> bytearray:
    """Build the 16-byte command frame expected by the JStyle BLE SDK.

    JStyle commands use bytes 0..14 for the opcode and arguments, with the
    low byte of their sum in byte 15. Building every command here prevents
    accidentally sending checksum-less 15-byte frames that J2208A ignores.
    """
    if not values or len(values) > 15:
        raise ValueError("JStyle command requires between 1 and 15 data bytes")
    if any(not isinstance(value, int) or not 0 <= value <= 0xFF for value in values):
        raise ValueError("JStyle command bytes must be integers from 0 to 255")

    frame = bytearray(16)
    frame[:len(values)] = bytes(values)
    frame[15] = sum(frame[:15]) & 0xFF
    return frame

# --- Wear OS GATT UUIDs (Wear OS acts as BLE Peripheral / GATT Server) ---
WEAROS_SERVICE_UUID = "0000b100-0000-1000-8000-00805f9b34fb"
WEAROS_VITALS_UUID = "0000b101-0000-1000-8000-00805f9b34fb"

# --- MQTT Topics ---
TOPIC_VITALS = "ble/vitals"
TOPIC_HEART = "ble/heart"
TOPIC_SPO2 = "ble/spo2"
TOPIC_SPO2_QUALITY = "ble/spo2_quality"
TOPIC_TEMP = "ble/temp"
TOPIC_BATT = "ble/batt"
TOPIC_STATUS = "ble/status"
TOPIC_RSSI = "ble/rssi"
TOPIC_SENSORS = "ble/sensors"
TOPIC_PAIRED_DEVICES = "nurseaid/paired_devices"


# ============================================================
# MQTT CLIENT
# ============================================================

class MQTTManager:
    """Manages MQTT connection, publishing, and paired-device subscriptions."""

    def __init__(self, host: str, port: int, user: str, password: str):
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.client = None
        self._pending_paired_update: Optional[dict] = None
        self._paired_update_lock = threading.Lock()
        self._connect()

    def _connect(self):
        # Prefer Paho's current callback API while retaining a 1.x fallback for
        # older field installations that have not upgraded the dependency yet.
        try:
            self.client = mqtt.Client(
                mqtt.CallbackAPIVersion.VERSION2,
                client_id=f"nurseaid_gateway_{int(time.time())}"
            )
        except AttributeError:
            # paho-mqtt 1.x — no CallbackAPIVersion
            self.client = mqtt.Client(client_id=f"nurseaid_gateway_{int(time.time())}")

        if self.user and self.password:
            self.client.username_pw_set(self.user, self.password)

        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_message = self._on_message
        self.client.reconnect_delay_set(min_delay=1, max_delay=30)

        attempts = 0
        while attempts < 5:
            try:
                self.client.connect(self.host, self.port, keepalive=60)
                self.client.loop_start()
                print(f"[MQTT] Connected to {self.host}:{self.port}")
                return
            except Exception as e:
                attempts += 1
                print(f"[MQTT] Connect attempt {attempts}/5 failed: {e}")
                if attempts < 5:
                    time.sleep(5 * attempts)

        print("[MQTT] WARNING: Could not connect after 5 attempts — MQTT will not work")

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        if reason_code == 0:
            print("[MQTT] Connected successfully")
            client.subscribe(TOPIC_PAIRED_DEVICES, qos=1)
            print(f"[MQTT] Subscribed to {TOPIC_PAIRED_DEVICES}")
        else:
            print(f"[MQTT] Connected but broker returned error code {reason_code}")

    def _on_disconnect(
        self,
        client,
        userdata,
        disconnect_flags_or_rc,
        reason_code=None,
        properties=None,
    ):
        # Callback API v1 passes rc as the third argument; v2 passes
        # disconnect_flags followed by a ReasonCode.
        rc = reason_code if reason_code is not None else disconnect_flags_or_rc
        if rc != 0:
            print(f"[MQTT] Unexpected disconnect (rc={rc}), trying reconnect...")
            try:
                self.client.reconnect()
            except Exception:
                pass

    def publish_json(self, topic: str, payload: dict):
        if not self.client or not self.client.is_connected():
            return
        try:
            text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            self.client.publish(topic, text, qos=1, retain=False)
        except Exception as e:
            print(f"[MQTT ERROR] publish failed: {e}")

    def _on_message(self, client, userdata, msg):
        """Handle incoming MQTT messages (paired device list from server)."""
        if msg.topic != TOPIC_PAIRED_DEVICES:
            return
        try:
            data = json.loads(msg.payload.decode("utf-8"))
            devices = data.get("devices", [])
            with self._paired_update_lock:
                self._pending_paired_update = data
            print(f"[MQTT] Received paired device update: {len(devices)} device(s)")
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            print(f"[MQTT] Failed to parse paired device message: {e}")

    def pop_pending_paired_update(self) -> Optional[dict]:
        """Atomically retrieve and clear the pending paired device update."""
        with self._paired_update_lock:
            update = self._pending_paired_update
            self._pending_paired_update = None
            return update

    def stop(self):
        if self.client:
            self.client.loop_stop()
            self.client.disconnect()


# ============================================================
# POSTGRESQL DEVICE REGISTRY
# ============================================================

class DeviceRegistry:
    """Reads device list from PostgreSQL nurseaid table dynamically."""

    def __init__(self, host: str, port: int, dbname: str, user: str, password: str):
        self.host = host
        self.port = port
        self.dbname = dbname
        self.user = user
        self.password = password
        self.registered_macs: set = set()
        self.device_metadata: Dict[str, dict] = {}
        self.require_paired = BLE_REQUIRE_PAIRED

    def _build_connection_string(self) -> dict:
        return {
            "host": self.host,
            "port": self.port,
            "dbname": self.dbname,
            "user": self.user,
            "password": self.password,
        }

    async def sync_from_db(self) -> tuple:
        """
        Query nurseaid table and update registered_macs + device_metadata.
        Returns (count_loaded, count_new, count_removed)
        """
        conn_params = self._build_connection_string()
        try:
            conn = psycopg2.connect(**conn_params)
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

            # Build query based on BLE_REQUIRE_PAIRED. Treat whitespace-only
            # HNs as unpaired as well; PostgreSQL's IS NOT NULL alone would
            # otherwise let incomplete assignments consume a BLE connection.
            where_clauses = ["mac IS NOT NULL", "mac <> ''"]
            if self.require_paired:
                where_clauses.append("NULLIF(BTRIM(hm_number), '') IS NOT NULL")

            query = f"""
                SELECT mac, device_no, hm_number, name, bed_no,
                       COALESCE(device_type, 'jstyle') AS device_type
                FROM nurseaid
                WHERE {' AND '.join(where_clauses)}
                ORDER BY device_no;
            """
            try:
                cur.execute(query)
            except Exception as e:
                # Backward compatibility for existing DBs without device_type column.
                if "device_type" not in str(e):
                    raise
                conn.rollback()
                fallback_query = f"""
                    SELECT mac, device_no, hm_number, name, bed_no,
                           'jstyle' AS device_type
                    FROM nurseaid
                    WHERE {' AND '.join(where_clauses)}
                    ORDER BY device_no;
                """
                cur.execute(fallback_query)
            rows = cur.fetchall()

            new_macs = set()
            new_metadata = {}

            for row in rows:
                mac = row["mac"].upper().strip()
                new_macs.add(mac)
                new_metadata[mac] = {
                    "device_no": row.get("device_no", ""),
                    "hm_number": row.get("hm_number", ""),
                    "name": row.get("name", ""),
                    "bed_no": row.get("bed_no", ""),
                    "device_type": (row.get("device_type") or "jstyle").lower(),
                }

            count_removed = len(self.registered_macs - new_macs)
            count_new = len(new_macs - self.registered_macs)

            self.registered_macs = new_macs
            self.device_metadata = new_metadata

            cur.close()
            conn.close()

            return (len(self.registered_macs), count_new, count_removed)

        except Exception as e:
            print(f"[DB ERROR] sync_from_db failed: {e}")
            return (len(self.registered_macs), 0, 0)

    def apply_mqtt_update(self, devices: list) -> tuple:
        """Apply a paired device list received via MQTT.

        This provides instant registry updates without waiting for
        the periodic database poll.

        Returns (count_loaded, count_new, count_removed)
        """
        try:
            new_macs = set()
            new_metadata = {}

            for device in devices:
                mac_raw = device.get("mac")
                if not mac_raw:
                    continue
                mac = str(mac_raw).upper().strip()
                if not mac:
                    continue
                new_macs.add(mac)
                new_metadata[mac] = {
                    "device_no": device.get("device_no", ""),
                    "hm_number": device.get("hm_number", ""),
                    "name": device.get("name", ""),
                    "bed_no": device.get("bed_no", ""),
                    "device_type": (device.get("device_type") or "jstyle").lower(),
                }

            count_removed = len(self.registered_macs - new_macs)
            count_new = len(new_macs - self.registered_macs)

            self.registered_macs = new_macs
            self.device_metadata = new_metadata

            return (len(self.registered_macs), count_new, count_removed)
        except Exception as e:
            print(f"[MQTT] apply_mqtt_update failed: {e}")
            return (len(self.registered_macs), 0, 0)


# ============================================================
# WearOS Device Handler (NurseAid GATT Peripheral)
# ============================================================

class WearOSDeviceHandler:
    """Handles NurseAid Wear OS BLE GATT notifications containing UTF-8 JSON."""

    @staticmethod
    def extract_json_frames(buffer: bytes) -> tuple[list[bytes], bytes]:
        """Extract balanced JSON objects from a fragmented notification stream."""
        frames = []
        start = None
        depth = 0
        in_string = False
        escaped = False

        for index, value in enumerate(buffer):
            if start is None:
                if value == ord("{"):
                    start = index
                    depth = 1
                    in_string = False
                    escaped = False
                continue

            if in_string:
                if escaped:
                    escaped = False
                elif value == ord("\\"):
                    escaped = True
                elif value == ord('"'):
                    in_string = False
                continue

            if value == ord('"'):
                in_string = True
            elif value == ord("{"):
                depth += 1
            elif value == ord("}"):
                depth -= 1
                if depth == 0:
                    frames.append(bytes(buffer[start:index + 1]))
                    start = None

        remainder = bytes(buffer[start:]) if start is not None else b""
        return frames, remainder

    @staticmethod
    def parse_vitals(mac: str, data: bytes, *, log_errors: bool = True):
        """
        Expected compact JSON example:
        {"mac":"WEAROS001","hr":82,"spo2":97,"temp":36.6,"batt":88,"status":1}
        """
        try:
            text = data.decode("utf-8", errors="ignore").strip().strip("\x00")
            if not text:
                return None
            payload = json.loads(text)
        except Exception as e:
            if log_errors:
                print(f"[WearOS] {mac}: JSON parse error: {e}")
            return None

        def first(*keys):
            for key in keys:
                if key in payload and payload[key] is not None:
                    return payload[key]
            return None

        extracted = {
            "hr": first("hr", "heart", "heart_rate"),
            "spo2": first("spo2", "s"),
            "temp": first("temp", "temperature", "t"),
            "batt": first("batt", "battery", "b"),
            "status": first("status"),
            "provider": "wear_os",
            "raw_provider": first("provider") or "wear_os",
        }

        # Remove empty values but keep explicit zero values.
        return {k: v for k, v in extracted.items() if v is not None}


class JStyleDeviceHandler:
    """
    Defensive parser for JStyle/iStyle notifications.

    JStyle/iStyle firmware variants that expose FFF6/FFF7 are not fully
    consistent across models.  This parser therefore supports:
      - UTF-8 JSON / key-value payloads, if a newer bridge firmware sends text
      - common opcode based binary packets for HR/Temp, SpO2 and battery
      - safe no-op behaviour for unknown packets, so the gateway never crashes
    """

    PROVIDER = "jstyle"

    @staticmethod
    def _to_int(value) -> Optional[int]:
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _to_float(value) -> Optional[float]:
        try:
            return round(float(value), 1)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _has_vital(data: dict) -> bool:
        return any(key in data for key in ("hr", "spo2", "temp", "batt", "status"))

    @staticmethod
    def _normalize_identifier(value) -> str:
        if value is None:
            return ""
        return re.sub(r"[^A-Fa-f0-9]", "", str(value)).upper()

    @classmethod
    def parse_manufacturer_data(cls, mac: str, manufacturer_data: dict) -> Optional[dict]:
        """
        Parse J2208A-style advertisement Manufacturer Data.

        Real-device capture while worn showed payloads such as:
          2208210202069f200000000000000069013f39002d0000000000
          220821020206a0f400000000000000e200470000000000000000

        Layout observed so far:
          - bytes 0..1  : model/family prefix (22 08)
          - bytes 2..7  : device BLE MAC
          - byte 17     : current heart rate when worn (e.g. 0x3f=63, 0x47=71)

        Other bytes may contain counters/flags and are intentionally not
        published until their meaning is confirmed for this model family.
        """
        # J2208A advertisements can retain the last measured HR after the watch
        # is removed. They do not contain a confirmed wear flag, so publishing
        # byte 17 as a fresh clinical reading would make stale data look live.
        # Advertisements remain useful for discovery; vitals come from GATT.
        return None

    @classmethod
    def parse_advertisement(cls, mac: str, advertisement_data) -> Optional[dict]:
        manufacturer_data = getattr(advertisement_data, "manufacturer_data", {}) or {}
        return cls.parse_manufacturer_data(mac, manufacturer_data)

    @classmethod
    def _normalize_payload(cls, payload: dict, raw_provider: str) -> dict:
        def first(*keys):
            for key in keys:
                if key in payload and payload[key] is not None:
                    return payload[key]
            return None

        extracted = {
            "hr": cls._to_int(first("hr", "heart", "heart_rate", "pulse")),
            "spo2": cls._to_int(first("spo2", "oxygen", "oxygen_saturation", "s")),
            "temp": cls._to_float(first("temp", "temperature", "skin_temp", "t")),
            "batt": cls._to_int(first("batt", "battery", "battery_level", "b")),
            "status": cls._to_int(first("status", "wear", "wearing", "is_wearing")),
            "provider": cls.PROVIDER,
            "raw_provider": first("provider", "source") or raw_provider,
        }
        return {k: v for k, v in extracted.items() if v is not None}

    @classmethod
    def _parse_text_payload(cls, text: str) -> Optional[dict]:
        # JSON format, e.g. {"hr":75,"spo2":98,"temp":36.5,"batt":85}
        if text.startswith("{"):
            try:
                payload = json.loads(text)
                if isinstance(payload, dict):
                    extracted = cls._normalize_payload(payload, "jstyle_text_json")
                    return extracted if cls._has_vital(extracted) else None
            except Exception:
                return None

        # Key/value text format, e.g. hr=75,spo2=98,temp=36.5,batt=85
        pairs = re.findall(
            r"(?i)\b(hr|heart|heart_rate|pulse|spo2|oxygen|s|temp|temperature|t|batt|battery|b|status)\b\s*[:=]\s*(-?\d+(?:\.\d+)?)",
            text,
        )
        if pairs:
            payload = {key.lower(): value for key, value in pairs}
            extracted = cls._normalize_payload(payload, "jstyle_text_kv")
            return extracted if cls._has_vital(extracted) else None

        return None

    @staticmethod
    def _find_byte(
        values: list,
        minimum: int,
        maximum: int,
        start: int = 1,
        preferred_indexes: Optional[list] = None,
        exclude_indexes: Optional[set] = None,
    ) -> tuple:
        exclude_indexes = exclude_indexes or set()
        indexes = []
        if preferred_indexes:
            indexes.extend(i for i in preferred_indexes if start <= i < len(values))
        indexes.extend(i for i in range(start, len(values)) if i not in indexes)

        for idx in indexes:
            if idx in exclude_indexes:
                continue
            value = values[idx]
            if minimum <= value <= maximum:
                return value, idx
        return None, None

    @staticmethod
    def _find_temperature(data: bytes, start: int = 1) -> Optional[float]:
        # Many watches encode skin temperature as integer Celsius*10 or *100.
        # Try both endian forms because firmware variants differ.
        for idx in range(start, max(start, len(data) - 1)):
            raw_le = data[idx] | (data[idx + 1] << 8)
            raw_be = (data[idx] << 8) | data[idx + 1]
            for raw in (raw_le, raw_be):
                for scale in (10.0, 100.0):
                    value = round(raw / scale, 1)
                    if 30.0 <= value <= 45.0:
                        return value

        # Some firmwares send whole-degree skin temperature as one byte.
        for idx in range(start, len(data)):
            value = data[idx]
            if 30 <= value <= 45:
                return float(value)
        return None

    @classmethod
    def _parse_binary_payload(cls, data: bytes) -> Optional[dict]:
        if not data:
            return None

        values = list(data)
        opcode = values[0]
        extracted = {
            "provider": cls.PROVIDER,
            "raw_provider": f"jstyle_0x{opcode:02x}",
        }

        if opcode == 0x09:
            # Captured J2208A 25-byte HR/skin-temperature packet:
            # byte 21 is current HR (0 means off wrist/no reading), and bytes
            # 22-23 are little-endian Celsius * 10.
            if len(values) != 25:
                return None

            hr = values[21]
            temp = round((values[22] | (values[23] << 8)) / 10.0, 1)
            wearing = 1 if 30 <= hr <= 220 else 0
            extracted["status"] = wearing
            if wearing:
                extracted["hr"] = hr
                if 30.0 <= temp <= 45.0:
                    extracted["temp"] = temp

        elif opcode == 0x28:
            # Captured J2208A 16-byte SpO2 packet. During measurement byte 2
            # changes as the optical algorithm progresses while byte 3 remains
            # zero. The device puts the final SpO2 result in byte 3 only when
            # the measurement is complete, for example:
            #   28 03 4d 00 ... 55 01 ...  (progress, no result)
            #   28 03 4f 62 ... 55 01 ...  (final SpO2=0x62=98)
            # Bytes 8-9 are skin temperature, byte 10 is HR, byte 11 is wear
            # status, and byte 15 is the additive checksum of bytes 0..14.
            if len(values) != 16 or (sum(values[:-1]) & 0xFF) != values[-1]:
                return None

            spo2 = values[3]
            hr = values[10]
            wearing = 1 if values[11] == 1 else 0
            extracted["status"] = wearing
            if wearing:
                if 70 <= spo2 <= 100:
                    extracted["spo2"] = spo2
                if 30 <= hr <= 220:
                    extracted["hr"] = hr

        elif opcode == 0x13:
            # Battery response.
            if any(values[1:]):
                batt, _ = cls._find_byte(values, 1, 100, preferred_indexes=[1, 2, 3])
                if batt is not None:
                    extracted["batt"] = batt

        else:
            # Never infer clinical values from an undocumented packet layout.
            return None

        return extracted if cls._has_vital(extracted) else None

    @classmethod
    def parse_vitals(cls, mac: str, data: bytes) -> Optional[dict]:
        try:
            text = data.decode("utf-8", errors="ignore").strip().strip("\x00")
            if text:
                parsed = cls._parse_text_payload(text)
                if parsed:
                    return parsed

            return cls._parse_binary_payload(data)
        except Exception as e:
            print(f"[JStyle] {mac}: parse error: {e}")
            return None


# ============================================================
# VITALS NORMALIZER & MQTT PUBLISHER
# ============================================================

class VitalsPublisher:
    """Normalizes vitals from any device handler and publishes to MQTT."""

    def __init__(self, mqtt_manager: MQTTManager, publish_interval: int = 1):
        self.mqtt = mqtt_manager
        self.publish_interval = publish_interval
        self.last_published: Dict[str, Dict[str, float]] = {}

    def _get_first(self, data: dict, keys: list):
        for key in keys:
            if key in data and data[key] is not None:
                return data[key]
        return None

    def _to_int(self, value) -> Optional[int]:
        if value is None:
            return None
        try:
            return int(float(value))
        except (ValueError, TypeError):
            return None

    def _to_float(self, value) -> Optional[float]:
        if value is None:
            return None
        try:
            return round(float(value), 1)
        except (ValueError, TypeError):
            return None

    def publish_vitals(self, mac: str, extracted: dict, device_metadata: dict):
        """Normalize extracted values and publish to MQTT topics."""
        now = time.time()

        if mac not in self.last_published:
            self.last_published[mac] = {}

        provider = extracted.get("provider") or device_metadata.get("device_type") or "unknown"

        # Wear OS sends already-normalized values.
        hr = self._to_int(extracted.get("hr"))
        temp = self._to_float(extracted.get("temp"))
        spo2 = self._to_int(extracted.get("spo2"))
        spo2_quality = extracted.get("spo2_quality")
        if provider == JStyleDeviceHandler.PROVIDER and spo2 is not None and spo2_quality != "verified":
            # JStyle optical samples must pass the multi-round quality gate.
            spo2 = None
        batt = self._to_int(extracted.get("batt"))
        status = self._to_int(extracted.get("status"))
        if status not in (0, 1):
            status = None

        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        device_id = mac
        uuid_val = str(uuid.uuid4())

        # Unified vitals payload (same format as nurseaid_ble_server.py)
        vitals_payload = {
            "mac": device_id,
            "device_id": device_id,
            "time": timestamp,
            "uuid": uuid_val,
            "hr": hr,
            "spo2": spo2,
            "spo2_status": spo2_quality or ("verified" if spo2 else "unavailable"),
            "temp": temp,
            "temp_type": extracted.get("temp_type") or "skin",
            "temp_status": "ok" if temp else "null",
            "batt": batt,
            "status": status,
            "activity": extracted.get("activity") or "",
            "provider": provider,
            "source": "raspberrypi5_ble_gateway",
            "transport": "ble",
            "bridge": "raspberrypi5",
            "interval_sec": 60,
            "sample_epoch_ms": int(now * 1000),
        }

        # Add device metadata if available
        if device_metadata:
            vitals_payload["device_no"] = device_metadata.get("device_no", "")
            vitals_payload["hm_number"] = device_metadata.get("hm_number", "")
            vitals_payload["patient_name"] = device_metadata.get("name", "")
            vitals_payload["bed_no"] = device_metadata.get("bed_no", "")

        # Publish unified vitals
        if now - self.last_published[mac].get("vitals", 0) >= self.publish_interval:
            self.mqtt.publish_json(TOPIC_VITALS, vitals_payload)
            self.last_published[mac]["vitals"] = now

        # Publish legacy topics
        legacy_fields = {
            TOPIC_HEART: ("hr", hr),
            TOPIC_SPO2: ("spo2", spo2),
            TOPIC_TEMP: ("temp", temp),
            TOPIC_BATT: ("batt", batt),
            TOPIC_STATUS: ("status", status),
        }

        for topic, (field, value) in legacy_fields.items():
            status_changed = (
                topic == TOPIC_STATUS
                and value is not None
                and self.last_published[mac].get("status_value") != value
            )
            if status_changed or now - self.last_published[mac].get(topic, 0) >= self.publish_interval:
                if value is not None:
                    payload = {
                        "value": value,
                        "mac": device_id,
                        "device_id": device_id,
                        "time": timestamp,
                        "uuid": uuid_val,
                        "status": status,
                        "provider": provider,
                        "source": provider,
                        "sample_epoch_ms": int(now * 1000),
                    }
                    if topic == TOPIC_SPO2:
                        payload["quality"] = spo2_quality or ("verified" if provider != JStyleDeviceHandler.PROVIDER else "unavailable")
                    self.mqtt.publish_json(topic, payload)
                    self.last_published[mac][topic] = now
                    if topic == TOPIC_STATUS:
                        self.last_published[mac]["status_value"] = value

    def publish_activity(self, mac: str, activity: str, device_metadata: dict):
        """Publish a granular activity state (e.g. scanning, connecting) to the dashboard."""
        # Activity proves that the gateway is working on a device, not that the
        # watch is connected or being worn. Keep wear status independent.
        extracted = {"activity": activity}
        self.publish_vitals(mac, extracted, device_metadata)

    def publish_sensor_metrics(self, mac: str, extracted: dict, device_metadata: dict):
        now = time.time()
        if mac not in self.last_published:
            self.last_published[mac] = {}
        if now - self.last_published[mac].get(TOPIC_SENSORS, 0) < self.publish_interval:
            return

        raw_metrics = extracted.get("metrics") or {}
        metrics = {}
        for key, value in raw_metrics.items():
            normalized_key = re.sub(r"[^a-z0-9_]+", "_", str(key).strip().lower()).strip("_")
            if not normalized_key:
                continue
            try:
                numeric_value = float(value)
            except (TypeError, ValueError):
                continue
            if numeric_value == numeric_value and abs(numeric_value) != float("inf"):
                metrics[normalized_key] = numeric_value

        if not metrics:
            return

        payload = {
            "mac": mac,
            "device_id": mac,
            "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "uuid": str(uuid.uuid4()),
            "provider": extracted.get("provider") or device_metadata.get("device_type") or "unknown",
            "source": "raspberrypi5_ble_gateway",
            "transport": "ble_advertisement",
            "sample_epoch_ms": int(now * 1000),
            "metrics": metrics,
        }
        if device_metadata:
            payload["device_no"] = device_metadata.get("device_no", "")
            payload["hm_number"] = device_metadata.get("hm_number", "")
            payload["bed_no"] = device_metadata.get("bed_no", "")
        self.mqtt.publish_json(TOPIC_SENSORS, payload)
        self.last_published[mac][TOPIC_SENSORS] = now

    def publish_spo2_quality(self, mac: str, quality: str, device_metadata: dict, **details):
        """Publish SpO2 measurement state independently from clinical values."""
        payload = {
            "mac": mac,
            "device_id": mac,
            "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "uuid": str(uuid.uuid4()),
            "status": quality,
            "provider": JStyleDeviceHandler.PROVIDER,
            "source": "raspberrypi5_ble_gateway",
            "sample_epoch_ms": int(time.time() * 1000),
        }
        payload.update({key: value for key, value in details.items() if value is not None})
        if device_metadata:
            payload["device_no"] = device_metadata.get("device_no", "")
        self.mqtt.publish_json(TOPIC_SPO2_QUALITY, payload)

    @staticmethod
    def _rssi_quality(rssi: int) -> str:
        """Map an RSSI reading to a small, dashboard-friendly quality label."""
        if rssi >= -60:
            return "excellent"
        if rssi >= -70:
            return "good"
        if rssi >= -80:
            return "fair"
        if rssi >= BLE_RSSI_MIN_THRESHOLD:
            return "weak"
        return "critical"

    def publish_rssi(self, mac: str, rssi: int, source: str = "connection"):
        """Publish a fresh RSSI reading, rate-limited independently per device."""
        try:
            rssi = int(rssi)
        except (TypeError, ValueError):
            return

        # Bluetooth RSSI is a signed 8-bit dBm value. Reject malformed values so
        # monitoring never presents an invalid reading as a real signal level.
        if not -127 <= rssi <= 20:
            return

        now = time.time()
        if mac not in self.last_published:
            self.last_published[mac] = {}

        if now - self.last_published[mac].get(TOPIC_RSSI, 0) >= RSSI_READ_INTERVAL:
            payload = {
                "value": rssi,
                "mac": mac,
                "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "uuid": str(uuid.uuid4()),
                "unit": "dBm",
                "quality": self._rssi_quality(rssi),
                "source": source,
            }
            self.mqtt.publish_json(TOPIC_RSSI, payload)
            self.last_published[mac][TOPIC_RSSI] = now


# ============================================================
# MAIN BLE GATEWAY
# ============================================================

class NurseAidBLEGateway:
    """
    Main gateway class that orchestrates:
    - PostgreSQL device registry sync
    - BLE scanning and connection management
    - Wear OS GATT communication
    - MQTT vitals publishing
    """

    def __init__(self):
        self.shutdown_event = asyncio.Event()
        self.shutdown_complete = asyncio.Event()
        self.shutdown_started = False
        # Prevent the watchdog from starting discovery while startup cleanup is
        # still disconnecting stale links and stopping adapter discovery.
        self.startup_cleanup_complete = asyncio.Event()
        self.background_tasks = []
        self.mqtt_manager: Optional[MQTTManager] = None
        self.device_registry: Optional[DeviceRegistry] = None
        self.vitals_publisher: Optional[VitalsPublisher] = None

        # BLE state
        self.scanner: Optional[BleakScanner] = None
        self.scanner_started_at = 0.0
        self.last_advertisement_timestamp = 0.0
        self.controller_heartbeat = time.time()
        self.discovery_status_cache: Optional[bool] = None
        self.discovery_status_checked_at = 0.0
        self.discovery_status_retry_at = 0.0
        self.discovery_status_last_error_log = 0.0
        self.scanner_control_lock = asyncio.Lock()
        self.adapter_manager = AdaptiveAdapterManager(
            BLE_ADAPTER_ADDRESSES,
            affinity_lease_seconds=BLE_AFFINITY_LEASE_SECONDS,
            switch_margin=BLE_AFFINITY_SWITCH_MARGIN,
            max_connections_per_adapter=BLE_MAX_GATT_CONNECTIONS_PER_ADAPTER,
            max_measurements_per_adapter=BLE_MAX_ACTIVE_MEASUREMENTS_PER_ADAPTER,
        )
        self.scanners: Dict[str, BleakScanner] = {}
        self.scanner_started_at_by_adapter: Dict[str, float] = {}
        self.last_advertisement_by_adapter: Dict[str, float] = {}
        self.scanner_recovery_until_by_adapter: Dict[str, float] = {}
        self.scanner_locks: Dict[str, asyncio.Lock] = {}
        self.adapter_locks: Dict[str, asyncio.Lock] = {}
        self.discovered: Dict[str, dict] = {}  # mac -> {device, rssi, seen}
        self.device_state: Dict[str, dict] = {}  # mac -> runtime state
        self.ble_adapter_lock = asyncio.Lock()
        # GATT setup is serialized per adapter, but measurements are independent.
        # Only command writes use these short-lived locks; a device must never
        # hold an adapter/global lock while waiting for a notification.
        self.command_locks: Dict[str, asyncio.Lock] = {}
        self.measurement_semaphores: Dict[str, asyncio.Semaphore] = {}
        self.measurement_queue_depth: Dict[str, int] = {}
        self.clinical_successes = 0
        self.empty_clinical_cycles = 0

        # Error handling
        self.inprogress_error_counter = 0
        self.recovery_attempt = 0
        self.scanner_stale_recovery_count = 0
        self.last_unmatched_wearos_log = 0

    @property
    def dual_adapter_enabled(self) -> bool:
        """Backward-compatible flag for adaptive scheduling with 2+ adapters."""
        return BLE_DUAL_ADAPTER_MODE == "adaptive" and len(self.adapter_manager.adapters) > 1

    @property
    def adapter_mode(self) -> str:
        """Expose the actual controller topology without changing legacy config names."""
        if not self.dual_adapter_enabled:
            return "single"
        return "dual" if len(self.adapter_manager.adapters) == 2 else "multi"

    async def _discover_adapter_inventory(self) -> list[AdapterRuntime]:
        """Resolve stable public controller addresses to current hci interfaces."""
        try:
            inventory = []
            interfaces = sorted(
                path.name for path in Path("/sys/class/bluetooth").glob("hci[0-9]*")
                if re.fullmatch(r"hci\d+", path.name)
            )
            for interface in interfaces:
                proc = await asyncio.create_subprocess_shell(
                    f"busctl get-property org.bluez /org/bluez/{interface} "
                    "org.bluez.Adapter1 Address",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=3.0)
                match = re.search(r"([0-9A-Fa-f:]{17})", stdout.decode(errors="ignore"))
                if proc.returncode == 0 and match:
                    inventory.append(AdapterRuntime(normalize_address(match.group(1)), interface))
            return inventory
        except Exception as error:
            print(f"[BLE] Adapter inventory error: {error}")
            return []

    async def _initialize_adapters(self) -> None:
        inventory = await self._discover_adapter_inventory()
        await self._enforce_central_only_mode(inventory)
        self.adapter_manager.set_inventory(inventory)
        for runtime in self.adapter_manager.adapters.values():
            self.scanner_locks.setdefault(runtime.address, asyncio.Lock())
            self.adapter_locks.setdefault(runtime.address, asyncio.Lock())
            self.last_advertisement_by_adapter.setdefault(runtime.address, 0.0)
        if not self.adapter_manager.adapters:
            print("[BLE] No configured adapter resolved; using BlueZ default compatibility mode")
            return
        mode = (
            f"{self.adapter_mode}-adapter adaptive "
            f"({len(self.adapter_manager.adapters)} controllers)"
            if self.dual_adapter_enabled
            else "single-adapter"
        )
        print(f"[BLE] {mode} mode resolved")
        for runtime in self.adapter_manager.adapters.values():
            print(f"[BLE] Adapter {runtime.address} -> {runtime.interface}")

    async def _enforce_central_only_mode(self, inventory: list[AdapterRuntime]) -> None:
        """Disable incoming pairing/discovery without affecting central GATT links."""
        for runtime in inventory:
            path = f"/org/bluez/{runtime.interface}"
            results = []
            for prop in ("Pairable", "Discoverable"):
                results.append(await self._run_shell(
                    f"busctl set-property org.bluez {path} "
                    f"org.bluez.Adapter1 {prop} b false",
                    timeout=5.0,
                ))
            if all(results):
                print(
                    f"[BLE] Adapter {runtime.interface} ({runtime.address}) "
                    "central-only: Pairable=false, Discoverable=false"
                )
            else:
                print(
                    f"[BLE] WARNING: could not fully enforce central-only mode "
                    f"on {runtime.interface} ({runtime.address})"
                )

    def _active_connection_count(self) -> int:
        return sum(1 for state in self.device_state.values() if state.get("connected"))

    def _connection_budget_has_capacity(self) -> bool:
        return self._active_connection_count() < BLE_MAX_GATT_CONNECTIONS

    def _scanner_capacity_missing(self) -> bool:
        """Return true when discovery can run on at least one idle adapter."""
        if not self.dual_adapter_enabled:
            return self.scanner is None
        return any(
            address not in self.scanners
            and runtime.healthy
            and runtime.active_connections < self.adapter_manager.max_connections_per_adapter
            for address, runtime in self.adapter_manager.adapters.items()
        )

    def _active_connection_count_for_mode(self, mode: str) -> int:
        metadata = getattr(self.device_registry, "device_metadata", {}) or {}
        return sum(
            1
            for mac, state in self.device_state.items()
            if state.get("connected")
            and DRIVER_REGISTRY.get(metadata.get(mac, {}).get("device_type", "jstyle")).mode == mode
        )

    def _is_registered_for_connection(self, mac: str) -> bool:
        """Return true only while the device remains patient-assigned."""
        registry = self.device_registry
        return bool(registry and mac in registry.registered_macs)

    def _can_start_gatt_connection(self, mac: str) -> bool:
        """Enforce the adapter budget and preserve capacity for a Wear OS link."""
        if not self._is_registered_for_connection(mac):
            return False
        if self._active_connection_count() >= BLE_MAX_GATT_CONNECTIONS:
            return False

        driver = self._driver_for(mac)
        if driver.mode != DRIVER_MODE_JSTYLE or BLE_RESERVED_WEAROS_SLOTS == 0:
            return True

        metadata = getattr(self.device_registry, "device_metadata", {}) or {}
        wearos_registered = any(
            DRIVER_REGISTRY.get(item.get("device_type", "jstyle")).mode == DRIVER_MODE_WEAROS
            for item in metadata.values()
        )
        if not wearos_registered:
            return True

        active_wearos = self._active_connection_count_for_mode(DRIVER_MODE_WEAROS)
        unfilled_reserved_slots = max(0, BLE_RESERVED_WEAROS_SLOTS - active_wearos)
        jstyle_limit = max(0, BLE_MAX_GATT_CONNECTIONS - unfilled_reserved_slots)
        return self._active_connection_count() < jstyle_limit

    def _operational_status(self) -> dict:
        """Return aggregate runtime status without device IDs or clinical data."""
        registry = self.device_registry
        active_measurements = sum(
            1 for state in self.device_state.values()
            if state.get("connected") and state.get("measurement_slot_held")
        )
        active_hr_temp = sum(
            1 for state in self.device_state.values()
            if state.get("connected") and state.get("measurement_slot_held")
            and state.get("monitor_phase") in {"wear_probe", "hr_temp"}
        )
        active_spo2 = sum(
            1 for state in self.device_state.values()
            if state.get("connected") and state.get("measurement_slot_held")
            and state.get("monitor_phase") in {"spo2_settle", "spo2"}
        )
        adapters = {
            runtime.interface: {
                "scannerActive": address in self.scanners,
                "connectionSetupActive": self._adapter_connect_attempt_active(address),
                "activeConnections": runtime.active_connections,
                "activeMeasurements": sum(
                    1 for state in self.device_state.values()
                    if state.get("connected")
                    and normalize_address(state.get("adapter_address", "")) == address
                    and state.get("measurement_slot_held")
                ),
                "measurementQueueDepth": self.measurement_queue_depth.get(address, 0),
                "healthy": runtime.healthy,
            }
            for address, runtime in self.adapter_manager.adapters.items()
        }
        return {
            "event": "operational_status",
            "registeredDevices": len(getattr(registry, "registered_macs", set()) or set()),
            "connectedDevices": self._active_connection_count(),
            "connectingDevices": sum(
                1
                for state in self.device_state.values()
                if state.get("connecting")
                and time.time() <= float(state.get("connect_deadline") or 0)
            ),
            "discoveredDevices": len(self.discovered),
            "scannerActive": self.scanner is not None,
            "criticalMeasurement": active_measurements > 0,
            "activeMeasurements": active_measurements,
            "activeHrTempMeasurements": active_hr_temp,
            "activeSpo2Measurements": active_spo2,
            "measurementQueueDepth": sum(self.measurement_queue_depth.values()),
            "clinicalSuccesses": self.clinical_successes,
            "emptyClinicalCycles": self.empty_clinical_cycles,
            "connectionBudget": BLE_MAX_GATT_CONNECTIONS,
            "adapterMode": self.adapter_mode,
            "adapters": adapters,
        }

    async def _operational_log_loop(self):
        """Emit a low-volume, privacy-safe status line for remote live logs."""
        while not self.shutdown_event.is_set():
            print(json.dumps(self._operational_status(), separators=(",", ":")))
            try:
                await asyncio.wait_for(
                    self.shutdown_event.wait(),
                    timeout=BLE_OPERATIONAL_LOG_INTERVAL,
                )
            except asyncio.TimeoutError:
                pass

    def _scanner_data_plane_stale(self, now: Optional[float] = None) -> bool:
        now = time.time() if now is None else now
        return (
            self._active_connection_count() == 0
            and now - self.last_advertisement_timestamp > BLE_SCANNER_STALE_SECONDS
        )

    def _adapter_scanner_silence_limit(self, adapter_address: str, now: float) -> float:
        """Allow a healthy scanner to be quiet when no nearby device uses it.

        In multi-controller mode a peer receiving advertisements does not prove
        that this controller's scanner is stuck: antenna placement and BlueZ's
        connection scheduling can legitimately leave one controller silent.
        The watchdog separately checks the adapter's Discovering property for a
        real control-plane failure before this longer data-plane limit expires.
        """
        return BLE_SCANNER_IDLE_RESTART_SECONDS

    def _write_health_state(self, discovering: Optional[bool] = None):
        """Expose controller/data-plane liveness to the container healthcheck."""
        now = time.time()
        active_connections = self._active_connection_count()
        critical = any(
            state.get("connected") and state.get("monitor_phase") == "spo2"
            for state in self.device_state.values()
        )
        advertisement_age = max(0.0, now - self.last_advertisement_timestamp)
        scanner_healthy = (
            active_connections > 0
            or critical
            or (bool(discovering) and advertisement_age <= BLE_SCANNER_STALE_SECONDS)
        )
        adapter_health = {}
        for address, runtime in self.adapter_manager.adapters.items():
            last_adv = self.last_advertisement_by_adapter.get(address, self.last_advertisement_timestamp)
            age = max(0.0, now - last_adv) if last_adv else None
            scanner_started = self.scanner_started_at_by_adapter.get(address, 0.0)
            scanner_silence = max(0.0, now - max(last_adv, scanner_started))
            scanner_silence_limit = self._adapter_scanner_silence_limit(address, now)
            active = runtime.active_connections
            scanner_active = address in self.scanners
            connection_setup_active = self._adapter_connect_attempt_active(address, now)
            adapter_measuring = any(
                state.get("connected")
                and normalize_address(state.get("adapter_address", "")) == address
                and state.get("monitor_phase") == "spo2"
                for state in self.device_state.values()
            )
            healthy = runtime.healthy and (
                active > 0
                or adapter_measuring
                or connection_setup_active
                or (
                    scanner_active
                    and max(last_adv, scanner_started) > 0
                    and scanner_silence <= scanner_silence_limit
                )
            )
            adapter_health[address] = {
                "interface": runtime.interface,
                "powered": runtime.powered,
                "healthy": healthy,
                "scannerActive": scanner_active,
                "connectionSetupActive": connection_setup_active,
                "activeConnections": active,
                "activeMeasurements": sum(
                    1 for state in self.device_state.values()
                    if state.get("connected")
                    and normalize_address(state.get("adapter_address", "")) == address
                    and state.get("monitor_phase") == "spo2"
                ),
                "lastAdvertisementAgeSeconds": round(age, 1) if age is not None else None,
                "scannerSilenceSeconds": round(scanner_silence, 1),
                "scannerSilenceLimitSeconds": round(scanner_silence_limit, 1),
            }
        if adapter_health:
            scanner_healthy = any(item["healthy"] for item in adapter_health.values())
        payload = {
            "timestamp": now,
            "controllerHeartbeat": self.controller_heartbeat,
            "discovering": discovering,
            "activeConnections": active_connections,
            "criticalMeasurement": critical,
            "lastAdvertisementAgeSeconds": round(advertisement_age, 1),
            "scannerHealthy": scanner_healthy,
            "mode": self.adapter_mode,
            "status": (
                f"healthy-{self.adapter_mode}"
                if self.dual_adapter_enabled and all(item["healthy"] for item in adapter_health.values())
                else "healthy-degraded"
                if scanner_healthy
                else "unhealthy"
            ),
            "adapters": adapter_health,
        }
        try:
            temporary = BLE_HEALTH_FILE.with_suffix(".tmp")
            temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
            temporary.replace(BLE_HEALTH_FILE)
        except OSError as error:
            print(f"[HEALTH] State write error: {error}")

    def _driver_for(self, mac: str):
        """Resolve a registered device to an explicit protocol driver."""
        metadata = getattr(self.device_registry, "device_metadata", {}) or {}
        device_type = metadata.get(mac, {}).get("device_type", "jstyle")
        return DRIVER_REGISTRY.get(device_type)

    # ----------------------------------------------------------
    # INITIALIZATION
    # ----------------------------------------------------------

    async def initialize(self):
        """Initialize all components."""
        print("=" * 60)
        print(" NurseAid BLE Gateway — Unified BLE Central Gateway")
        print("=" * 60)
        print(f"  DB Host:        {DB_HOST}:{DB_PORT}")
        print(f"  DB Name:        {DB_NAME}")
        print(f"  MQTT Host:      {MQTT_HOST}:{MQTT_PORT}")
        print(f"  BLE Require Paired: {BLE_REQUIRE_PAIRED}")
        print(f"  Device Sync:    every {BLE_DEVICE_SYNC_INTERVAL}s")
        print(f"  Connect Timeout: {BLE_CONNECT_TIMEOUT}s")
        print(f"  Connect Cleanup: {BLE_CONNECT_CLEANUP_TIMEOUT}s")
        print(f"  GATT Setup Timeout: {GATT_SETUP_TIMEOUT}s")
        print(f"  Watchdog:       every {WATCHDOG_INTERVAL}s")
        print(f"  GATT TX/RX:     {CHAR_TX} / {CHAR_RX}")
        print(f"  WearOS Service: {WEAROS_SERVICE_UUID}")
        print(f"  WearOS Vitals:  {WEAROS_VITALS_UUID}")
        print(f"  JStyle Commands: {JSTYLE_ENABLE_MEASURE_COMMANDS}")
        print(f"  JStyle Adv Publish: {JSTYLE_PUBLISH_ADVERTISEMENT}")
        print(f"  JStyle GATT Connect: {JSTYLE_CONNECT_FOR_GATT}")
        print(f"  GATT Connection Budget: {BLE_MAX_GATT_CONNECTIONS} (WearOS reserved: {BLE_RESERVED_WEAROS_SLOTS})")
        print(f"  JStyle Rotation: {JSTYLE_CYCLES_PER_CONNECTION} cycle(s) per connection")
        print(f"  JStyle Persistent Streaming: {JSTYLE_PERSISTENT_STREAMING}")
        print(
            f"  JStyle Recovery: command_retries={JSTYLE_COMMAND_RETRIES}, "
            f"SpO2_stream_retries={JSTYLE_SPO2_STREAM_RETRIES}"
        )
        print(f"  Sensor Drivers: {', '.join(DRIVER_REGISTRY.supported_types())}")
        print("=" * 60)

        await self._initialize_adapters()

        # Initialize MQTT
        self.mqtt_manager = MQTTManager(MQTT_HOST, MQTT_PORT, MQTT_USER, MQTT_PASSWORD)

        # Initialize Device Registry
        self.device_registry = DeviceRegistry(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD)

        # Initialize Vitals Publisher
        self.vitals_publisher = VitalsPublisher(self.mqtt_manager, MQTT_PUBLISH_INTERVAL)

        # Initialize device state for all registered devices
        for mac in self.device_registry.registered_macs:
            self._init_device_state(mac)

    def _init_device_state(self, mac: str):
        """Initialize runtime state for a device."""
        if mac not in self.device_state:
            self.device_state[mac] = {
                "connected": False,
                "connecting": False,
                "registry_active": True,
                "connect_started_at": 0,
                "connect_deadline": 0,
                "task": None,
                "fail_count": 0,
                "cooldown_until": 0,
                "last_connection_attempt": 0,
                "connected_time": None,
                "last_data_timestamp": 0,
                "monitor_phase": "idle",
                "phase_started_at": 0,
                "watchdog_deadline": 0,
                "monitor_ready_event": None,
                "monitor_setup_error": None,
                "monitor_failed": False,
                "monitor_fail_count": 0,
                "wearos_rx_buffer": b"",
                "wearos_rx_buffer_started_at": 0,
                "wearos_parse_error_streak": 0,
                "wearos_parse_error_count": 0,
                "wearos_last_parse_error_log": 0,
                "wearos_protocol_error_event": asyncio.Event(),
                "last_spo2_value": 0,
                "spo2_timeout_count": 0,
                "spo2_retry_count": 0,
                "last_battery_read": 0,
                "last_keepalive": 0,
                "last_rssi_read": 0,
                "hr_zero_start": None,
                # Unknown until enough protocol packets explicitly confirm worn/off-wrist.
                "is_wearing": None,
                "worn_confirmed_since_start": False,
                "spo2_ready": False,
                "spo2_candidate": 0,
                "spo2_candidate_count": 0,
                "spo2_samples": [],
                "spo2_warmup_remaining": 0,
                "spo2_quality": "unavailable",
                "spo2_off_wrist_seen": False,
                "last_spo2_end_time": 0,
                "last_jstyle_vitals": {},
                "last_adv_vitals_timestamp": 0,
                "off_wrist_confirmation_count": 0,
                "off_wrist_confirmation_started_at": 0,
                "last_confirmed_off_wrist_at": 0,
                "off_wrist_probe_after": 0,
                "wear_probe_active": False,
                "stop_measurement_requested": False,
                "phase_hr_samples": [],
                "phase_temp_samples": [],
                "phase_hr_temp_packet_seen": False,
                "phase_first_hr_at": 0,
                "phase_first_temp_at": 0,
                "spo2_last_progress_at": 0,
                "spo2_off_wrist_confirmed": False,
                "cycle_started_at": 0,
                # Per-metric SLA timestamps (when last good value was received)
                "last_hr_at": 0,
                "last_temp_at": 0,
                "last_spo2_verified_at": 0,
                "adapter_address": "",
                "cycle_data_received": False,
                "cycle_clinical_success": False,
                "measurement_slot_held": False,
                "measurement_slot_address": "",
                "session_generation": 0,
                "notification_event": asyncio.Event(),
                "spo2_progress_event": asyncio.Event(),
                "spo2_final_event": asyncio.Event(),
                "off_wrist_event": asyncio.Event(),
                "last_result": "never_started",
                "last_failure_reason": None,
                "completed_cycles": 0,
            }

    def _lock_for_device(self, mac: str) -> asyncio.Lock:
        address = normalize_address(self.device_state.get(mac, {}).get("adapter_address", ""))
        return self.adapter_locks.get(address, self.ble_adapter_lock)

    def _adapter_connect_attempt_active(
        self, adapter_address: str, now: Optional[float] = None
    ) -> bool:
        """Return whether an adapter is inside a bounded GATT setup window."""
        address = normalize_address(adapter_address)
        now = time.time() if now is None else now
        return any(
            state.get("connecting")
            and normalize_address(state.get("adapter_address", "")) == address
            and now <= float(state.get("connect_deadline") or 0)
            for state in self.device_state.values()
        )

    def _record_device_data_success(self, mac: str, extracted: dict) -> bool:
        """Record a valid clinical value, never mere protocol activity."""
        provider = extracted.get("provider")
        has_clinical_value = any(
            extracted.get(key) is not None for key in ("hr", "temp", "spo2")
        )
        if not has_clinical_value:
            return False
        if provider == JStyleDeviceHandler.PROVIDER and extracted.get("status") != 1:
            return False
        state = self.device_state.get(mac, {})
        state["cycle_data_received"] = True
        state["cycle_clinical_success"] = True
        return True

    async def _acquire_measurement_slot(self, mac: str) -> None:
        state = self.device_state[mac]
        if state.get("measurement_slot_held"):
            return
        address = normalize_address(state.get("adapter_address", "")) or "DEFAULT"
        wait_budget = max(
            DATA_RECEIVE_TIMEOUT,
            BLE_MAX_GATT_CONNECTIONS_PER_ADAPTER * (
                PHASE_1_DURATION + PHASE_2_TIMEOUT + SPO2_SENSOR_SETTLE_SECONDS
            ),
        )
        self._set_monitor_phase(mac, "measurement_wait", wait_budget)
        semaphore = self.measurement_semaphores.setdefault(
            address, asyncio.Semaphore(BLE_MAX_ACTIVE_MEASUREMENTS_PER_ADAPTER)
        )
        self.measurement_queue_depth[address] = self.measurement_queue_depth.get(address, 0) + 1
        try:
            await semaphore.acquire()
        finally:
            self.measurement_queue_depth[address] = max(
                0, self.measurement_queue_depth.get(address, 1) - 1
            )
        state["measurement_slot_held"] = True
        state["measurement_slot_address"] = address
        state["cycle_clinical_success"] = False
        state["cycle_data_received"] = False
        runtime = self.adapter_manager.adapters.get(address)
        if runtime:
            runtime.active_measurements += 1
        state["cycle_started_at"] = time.time()

    def _release_measurement_slot(self, mac: str, *, record_result: bool = True) -> None:
        """Release a per-adapter slot, optionally deferring cycle accounting.

        A recoverable stream retry must yield the radio to queued watches, but
        it is not a completed empty clinical cycle until all retries fail.
        """
        state = self.device_state.get(mac, {})
        if not state.get("measurement_slot_held"):
            return
        address = normalize_address(state.get("measurement_slot_address", "")) or "DEFAULT"
        success = bool(state.get("cycle_clinical_success"))
        state["measurement_slot_held"] = False
        state["measurement_slot_address"] = ""
        state["monitor_phase"] = "measurement_idle"
        state["phase_started_at"] = time.time()
        state["watchdog_deadline"] = time.time() + DATA_RECEIVE_TIMEOUT
        runtime = self.adapter_manager.adapters.get(address)
        if runtime:
            runtime.active_measurements = max(0, runtime.active_measurements - 1)
            if record_result:
                self.adapter_manager.record_data_result(mac, address, success)
        if record_result:
            if success:
                self.clinical_successes += 1
                state["consecutive_empty_cycles"] = 0
            else:
                self.empty_clinical_cycles += 1
                state["consecutive_empty_cycles"] = state.get("consecutive_empty_cycles", 0) + 1
                # Publish sensor_failure activity after 3 consecutive empty cycles
                # so the dashboard can show a warning icon instead of blank data.
                if state["consecutive_empty_cycles"] == 3 and self.vitals_publisher:
                    device_metadata = (
                        self.device_registry.device_metadata.get(mac, {})
                        if self.device_registry
                        else {}
                    )
                    # Sensor silence is distinct from an explicit off-wrist
                    # packet. Do not publish status=0 or overwrite wear state.
                    self.vitals_publisher.publish_activity(
                        mac, "sensor_failure", device_metadata
                    )
                    print(
                        f"  ⚠️ [JStyle] {mac}: sensor_failure — "
                        f"{state['consecutive_empty_cycles']} consecutive empty cycles"
                    )
        semaphore = self.measurement_semaphores.get(address)
        if semaphore:
            semaphore.release()
        if record_result:
            print(
                f"[BLE] {mac}: cycle_result="
                f"{'clinical_success' if success else 'no_clinical_samples'} "
                f"adapter={runtime.interface if runtime else address}"
            )
        else:
            print(
                f"[BLE] {mac}: measurement slot yielded for retry "
                f"adapter={runtime.interface if runtime else address}"
            )

    @staticmethod
    def _off_wrist_probe_due(state: dict, now: Optional[float] = None) -> bool:
        now = time.time() if now is None else float(now)
        return (
            state.get("is_wearing") == 0
            and now >= float(state.get("off_wrist_probe_after") or 0)
        )

    @classmethod
    def _defer_off_wrist_device(cls, state: dict, now: Optional[float] = None) -> bool:
        return state.get("is_wearing") == 0 and not cls._off_wrist_probe_due(state, now)

    @staticmethod
    def _jstyle_rotation_cooldown(state: dict, default: float) -> float:
        if state.get("is_wearing") == 0:
            return JSTYLE_OFF_WRIST_PROBE_INTERVAL
        if (
            state.get("is_wearing") is None
            and state.get("off_wrist_confirmation_count", 0) > 0
        ):
            return max(float(default), JSTYLE_OFF_WRIST_SUSPECT_RETRY)
        return float(default)

    def _set_monitor_phase(self, mac: str, phase: str, expected_seconds: float):
        """Record the active protocol phase and its watchdog deadline."""
        state = self.device_state[mac]
        now = time.time()
        state["monitor_phase"] = phase
        state["phase_started_at"] = now
        state["watchdog_deadline"] = now + max(float(expected_seconds), 1.0) + JSTYLE_PHASE_WATCHDOG_GRACE
        
        # Map phase to activity string
        activity = "measuring_hr" if phase == "hr_temp" else ("measuring_spo2" if phase == "spo2" else phase)
        metadata = self.device_registry.device_metadata.get(mac, {}) if self.device_registry else {}
        self.vitals_publisher.publish_activity(mac, activity, metadata)

    @staticmethod
    def _stable_sample_window(values, required: int, tolerance: float) -> bool:
        """Return true when the latest same-phase samples form a stable window."""
        if len(values) < required:
            return False
        window = values[-required:]
        return max(window) - min(window) <= tolerance

    def _phase1_ready(self, state: dict, elapsed: float) -> bool:
        if elapsed < PHASE_1_MIN_DURATION:
            return False
        return (
            self._stable_sample_window(
                state.get("phase_hr_samples", []),
                PHASE_1_STABLE_SAMPLES,
                PHASE_1_HR_TOLERANCE,
            )
            and self._stable_sample_window(
                state.get("phase_temp_samples", []),
                PHASE_1_STABLE_SAMPLES,
                PHASE_1_TEMP_TOLERANCE,
            )
        )

    def _connection_is_stale(self, state: dict, device_type: str, now: float) -> bool:
        """Return True only when a connection is outside its valid phase window."""
        phase_deadline = float(state.get("watchdog_deadline") or 0)
        driver = DRIVER_REGISTRY.get(device_type)
        if driver.mode == DRIVER_MODE_JSTYLE and phase_deadline > 0 and now <= phase_deadline:
            return False

        receive_timeout = DATA_RECEIVE_TIMEOUT
        if driver.mode == DRIVER_MODE_WEAROS:
            receive_timeout = max(
                receive_timeout,
                (WEAROS_NOTIFICATION_INTERVAL * 2) + WATCHDOG_INTERVAL,
            )

        timestamps = [
            state.get("last_data_timestamp"),
            state.get("connected_time"),
        ]
        last_activity = max(
            (float(value) for value in timestamps if value),
            default=now,
        )
        return (now - last_activity) > receive_timeout

    @staticmethod
    def _retry_backoff(fail_count: int) -> float:
        """Bound retry delay so weak devices cannot monopolize the adapter."""
        if fail_count <= 1:
            return 0.0  # Fast reconnect on first failure
        return min(
            BLE_RETRY_BACKOFF_MAX,
            BLE_RETRY_BACKOFF_BASE * (2 ** max(0, fail_count - 2)),
        )

    def _prioritize_connection_targets(self, targets):
        """Prioritize by: driver class → clinical alert urgency → SLA staleness
        → connection reliability → fairness rotation."""
        now = time.time()

        def _sla_staleness(mac: str) -> float:
            """Return the worst (largest) SLA gap for this device.
            Higher value = more urgent. Returns 0 for non-JStyle devices."""
            state = self.device_state.get(mac, {})
            driver = self._driver_for(mac)
            if driver.mode != DRIVER_MODE_JSTYLE:
                return 0.0
            gaps = [
                max(0.0, now - float(state.get("last_hr_at") or 0)) / SLA_HR_SECONDS,
                max(0.0, now - float(state.get("last_spo2_verified_at") or 0)) / SLA_SPO2_SECONDS,
                max(0.0, now - float(state.get("last_temp_at") or 0)) / SLA_TEMP_SECONDS,
            ]
            return max(gaps)

        def _alert_urgency(mac: str) -> float:
            """Boost priority for devices whose last-known vitals are in alert range.
            Higher value = more urgent (should be measured sooner)."""
            state = self.device_state.get(mac, {})
            last_vitals = state.get("last_jstyle_vitals", {})
            if not last_vitals or state.get("is_wearing") == 0:
                return 0.0
            urgency = 0.0
            hr = last_vitals.get("hr")
            if hr is not None:
                try:
                    hr = int(float(hr))
                    if hr < 50 or hr > 120:
                        urgency += 2.0
                except (TypeError, ValueError):
                    pass
            spo2 = last_vitals.get("spo2")
            if spo2 is not None:
                try:
                    spo2 = int(float(spo2))
                    if spo2 < 94:
                        urgency += 3.0
                except (TypeError, ValueError):
                    pass
            temp = last_vitals.get("temp")
            if temp is not None:
                try:
                    temp = float(temp)
                    if temp < 35.0 or temp > 38.5:
                        urgency += 1.5
                except (TypeError, ValueError):
                    pass
            return urgency

        def _connection_penalty(mac: str) -> float:
            """Penalize devices with high consecutive failure counts so they do
            not monopolize the adapter while other healthy devices are waiting.
            Lower penalty = scheduled sooner."""
            state = self.device_state.get(mac, {})
            fail_count = int(state.get("fail_count") or 0)
            monitor_fails = int(state.get("monitor_fail_count") or 0)
            # Off-wrist devices are already handled by _defer_off_wrist_device;
            # add a small extra penalty so they sort after worn devices at the
            # same urgency level.
            off_wrist = 5.0 if state.get("is_wearing") == 0 else 0.0
            # Forgive the first connection failure to allow a fast reconnect attempt
            effective_fail = max(0, fail_count - 1)
            return min(10.0, effective_fail * 1.5 + monitor_fails * 0.5) + off_wrist

        return sorted(
            targets,
            key=lambda mac: (
                self._driver_for(mac).priority,
                -_alert_urgency(mac),
                -_sla_staleness(mac),
                _connection_penalty(mac),
                float(self.device_state.get(mac, {}).get("last_connection_attempt") or 0),
                mac,
            ),
        )

    # ----------------------------------------------------------
    # DEVICE REGISTRY SYNC
    # ----------------------------------------------------------

    async def _reconcile_registered_devices(self) -> None:
        """Apply the patient-assigned registry to live BLE state.

        An unpaired device is removed from discovery immediately and an active
        monitor is cancelled so its ``finally`` block can stop measurements and
        disconnect cleanly. A connection that is still being established is
        marked inactive and will abort at the next registration check.
        """
        registered = set(self.device_registry.registered_macs)

        for mac in registered:
            if mac not in self.device_state:
                self._init_device_state(mac)
            self.device_state[mac]["registry_active"] = True

        cleanup_tasks = []
        removed = []
        for mac, state in list(self.device_state.items()):
            if mac in registered:
                continue

            state["registry_active"] = False
            self.discovered.pop(mac, None)
            monitor_task = state.get("task")

            if monitor_task and not monitor_task.done():
                print(
                    f"[DB] Device {mac} is no longer patient-assigned; "
                    "stopping measurement and disconnecting"
                )
                monitor_task.cancel()
                cleanup_tasks.append(monitor_task)
            elif state.get("connecting"):
                print(
                    f"[DB] Device {mac} is no longer patient-assigned; "
                    "aborting connection setup"
                )
            else:
                removed.append(mac)

        if cleanup_tasks:
            await asyncio.gather(*cleanup_tasks, return_exceptions=True)

        # Monitor cleanup has now released measurement/adapter capacity. Keep a
        # connecting state until its bounded connect attempt observes that the
        # assignment disappeared, otherwise it would retain a stale dict.
        for mac, state in list(self.device_state.items()):
            if mac in registered or state.get("connecting"):
                continue
            monitor_task = state.get("task")
            if monitor_task and not monitor_task.done():
                continue
            self._release_measurement_slot(mac)
            removed.append(mac)

        for mac in set(removed):
            self.device_state.pop(mac, None)

    async def sync_devices(self):
        """Periodically sync device list from database."""
        while not self.shutdown_event.is_set():
            try:
                # Check for instant MQTT-triggered update first
                mqtt_update = None
                if self.mqtt_manager:
                    mqtt_update = self.mqtt_manager.pop_pending_paired_update()

                if mqtt_update is not None:
                    devices = mqtt_update.get("devices", [])
                    count, new_count, removed_count = self.device_registry.apply_mqtt_update(devices)
                    source = "MQTT"
                else:
                    count, new_count, removed_count = await self.device_registry.sync_from_db()
                    source = "DB"

                if new_count > 0:
                    print(f"[{source}] Discovered {new_count} new device(s)")
                if removed_count > 0:
                    print(f"[{source}] Removed {removed_count} device(s)")

                await self._reconcile_registered_devices()

                print(f"[{source}] Active devices: {count}")

            except Exception as e:
                print(f"[DB SYNC ERROR] {e}")

            # If there is another pending MQTT update, process it quickly
            if self.mqtt_manager and self.mqtt_manager.pop_pending_paired_update() is not None:
                continue

            await asyncio.sleep(BLE_DEVICE_SYNC_INTERVAL)

    # ----------------------------------------------------------
    # BLE SCANNER
    # ----------------------------------------------------------

    @staticmethod
    def _normalize_identifier(value) -> str:
        """Normalize MAC/device identifiers for advertisement matching."""
        if value is None:
            return ""
        return re.sub(r"[^A-Fa-f0-9]", "", str(value)).upper()

    def _match_wearos_advertisement(self, device, advertisement_data) -> Optional[str]:
        """
        Match Wear OS advertisements to NurseAid logical MAC/Virtual MAC.

        Wear OS/Android commonly advertises with a random BLE address, so the
        BLE address is not reliable for pairing. We therefore match by:
          1) advertised local name containing logical MAC/device_no
          2) advertised service/manufacturer/service data containing logical MAC/device_no
          3) Wear OS service UUID / NurseAid-WearOS name when exactly one Wear OS device is registered
        """
        local_name = (
            getattr(advertisement_data, "local_name", None)
            or getattr(device, "name", None)
            or ""
        )
        service_uuids = [str(x).lower() for x in getattr(advertisement_data, "service_uuids", []) or []]

        text_parts = [local_name, getattr(device, "address", "")]

        for value in (getattr(advertisement_data, "manufacturer_data", {}) or {}).values():
            try:
                text_parts.append(bytes(value).decode("utf-8", errors="ignore"))
                text_parts.append(bytes(value).hex())
            except Exception:
                pass

        for key, value in (getattr(advertisement_data, "service_data", {}) or {}).items():
            text_parts.append(str(key))
            try:
                text_parts.append(bytes(value).decode("utf-8", errors="ignore"))
                text_parts.append(bytes(value).hex())
            except Exception:
                pass

        haystack = " ".join(text_parts)
        haystack_norm = self._normalize_identifier(haystack)

        wearos_macs = []
        for logical_mac, meta in self.device_registry.device_metadata.items():
            if meta.get("device_type") != "wearos":
                continue
            wearos_macs.append(logical_mac)

            logical_norm = self._normalize_identifier(logical_mac)
            candidates = [
                logical_mac,
                logical_mac.replace(":", ""),
                logical_norm[-4:] if len(logical_norm) >= 4 else "",
                f"NA-W-{logical_norm[-4:]}" if len(logical_norm) >= 4 else "",
                meta.get("device_no", ""),
            ]
            for candidate in candidates:
                candidate_norm = self._normalize_identifier(candidate)
                # Human-readable identifiers may contain very few hexadecimal
                # characters (for example WARE_OS -> AE). Never use such a short
                # normalized fragment for binary manufacturer-data matching.
                direct_match = candidate and str(candidate).upper() in haystack.upper()
                normalized_match = (
                    candidate_norm
                    and len(candidate_norm) >= 8
                    and candidate_norm in haystack_norm
                )
                if direct_match or normalized_match:
                    return logical_mac

        is_wearos_advert = (
            WEAROS_SERVICE_UUID.lower() in service_uuids
            or "NurseAid-WearOS".lower() in local_name.lower()
            or local_name.upper().startswith("NA-W-")
            or "NurseAid".lower() in local_name.lower() and "Wear".lower() in local_name.lower()
        )

        if is_wearos_advert and len(wearos_macs) == 1:
            return wearos_macs[0]

        if is_wearos_advert and wearos_macs:
            now = time.time()
            if now - self.last_unmatched_wearos_log > 10:
                print(
                    "[WearOS] Advertisement found but cannot map to a unique Virtual MAC. "
                    f"name='{local_name}' addr={getattr(device, 'address', '')} registered={wearos_macs}"
                )
                self.last_unmatched_wearos_log = now

        return None

    def _wearos_match_priority(self, logical_mac: str, ble_address: str, local_name: str) -> int:
        """Prefer advertisements that explicitly identify the registered Wear OS device."""
        metadata = self.device_registry.device_metadata.get(logical_mac, {})
        local_name_norm = self._normalize_identifier(local_name)
        logical_norm = self._normalize_identifier(logical_mac)
        device_no_norm = self._normalize_identifier(metadata.get("device_no", ""))

        if ble_address == logical_mac:
            return 3
        if logical_norm and logical_norm in local_name_norm:
            return 3
        if device_no_norm and device_no_norm in local_name_norm:
            return 3
        if local_name and (
            local_name.upper().startswith("NA-W-")
            or "nurseaid-wearos" in local_name.lower()
        ):
            return 2
        return 1

    def _match_driver_advertisement(self, device, advertisement_data) -> Optional[str]:
        """Match rotating BLE addresses using only an explicit driver's identity rule."""
        for logical_id, metadata in self.device_registry.device_metadata.items():
            driver = DRIVER_REGISTRY.get(metadata.get("device_type", "jstyle"))
            matcher = driver.advertisement_matcher
            if matcher and matcher(logical_id, device, advertisement_data):
                return logical_id
        return None

    def _adapter_detection_callback(self, adapter_address: str):
        def callback(device: BleakDevice, advertisement_data):
            self._detection_callback(device, advertisement_data, adapter_address)
        return callback

    def _detection_callback(
        self, device: BleakDevice, advertisement_data, adapter_address: Optional[str] = None
    ):
        """Called every time scanner sees an advertisement."""
        self.last_advertisement_timestamp = time.time()
        self.scanner_stale_recovery_count = 0
        ble_address = device.address.upper()
        logical_mac = ble_address

        if ble_address not in self.device_registry.registered_macs:
            logical_mac = self._match_driver_advertisement(device, advertisement_data)
            if not logical_mac:
                logical_mac = self._match_wearos_advertisement(device, advertisement_data)
            if not logical_mac:
                return

        now = time.time()
        adapter_address = normalize_address(adapter_address)
        if adapter_address:
            self.last_advertisement_by_adapter[adapter_address] = now
        metadata = self.device_registry.device_metadata.get(logical_mac, {})
        device_type = metadata.get("device_type", "jstyle")
        driver = DRIVER_REGISTRY.get(device_type)
        local_name = getattr(advertisement_data, "local_name", None) or getattr(device, "name", None)
        match_priority = 0

        if driver.mode == DRIVER_MODE_WEAROS:
            match_priority = self._wearos_match_priority(logical_mac, ble_address, local_name or "")
            existing = self.discovered.get(logical_mac)
            if existing:
                same_address = existing.get("ble_address") == ble_address
                existing_age = now - existing.get("seen", 0)
                existing_priority = existing.get("match_priority", 0)

                if same_address:
                    match_priority = max(match_priority, existing_priority)
                    local_name = local_name or existing.get("local_name")
                elif existing_age <= BLE_STALE_THRESHOLD and existing_priority > match_priority:
                    return

        rssi = getattr(advertisement_data, "rssi", None)
        discovered_info = {
            "device": device,
            "rssi": rssi,
            "seen": now,
            "ble_address": ble_address,
            "local_name": local_name,
            "match_priority": match_priority,
            "adapter_address": adapter_address,
        }
        if adapter_address and adapter_address in self.adapter_manager.adapters:
            self.adapter_manager.record_candidate(
                logical_mac,
                adapter_address,
                device=device,
                seen=now,
                rssi=rssi,
                ble_address=ble_address,
                local_name=local_name,
                match_priority=match_priority,
            )
            selected = self.adapter_manager.choose(logical_mac, BLE_STALE_THRESHOLD, now)
            if selected:
                selected_address, selected_candidate, _ = selected
                discovered_info = {
                    "device": selected_candidate.device,
                    "rssi": selected_candidate.median_rssi,
                    "seen": selected_candidate.seen,
                    "ble_address": selected_candidate.ble_address,
                    "local_name": selected_candidate.local_name,
                    "match_priority": selected_candidate.match_priority,
                    "adapter_address": selected_address,
                }
        self.discovered[logical_mac] = discovered_info

        # Bleak receives advertisement RSSI through BlueZ D-Bus even in
        # containers where legacy hcitool cannot open a raw HCI socket. Publish
        # this fresh measurement as the primary signal-health source.
        if self.vitals_publisher is not None and rssi is not None:
            self.vitals_publisher.publish_rssi(
                logical_mac, rssi, source="advertisement"
            )

        if driver.mode == DRIVER_MODE_JSTYLE and JSTYLE_PUBLISH_ADVERTISEMENT:
            extracted = JStyleDeviceHandler.parse_advertisement(logical_mac, advertisement_data)
            if extracted:
                if logical_mac not in self.device_state:
                    self._init_device_state(logical_mac)
                state = self.device_state.get(logical_mac, {})
                state["last_data_timestamp"] = time.time()
                state["last_adv_vitals_timestamp"] = time.time()
                state.setdefault("last_jstyle_vitals", {}).update(extracted)

                if extracted.get("status") == 1 or any(
                    float(extracted.get(field) or 0) > 0 for field in ("hr", "temp")
                ):
                    state["is_wearing"] = 1
                    state["worn_confirmed_since_start"] = True
                    state["off_wrist_confirmation_count"] = 0
                    state["off_wrist_confirmation_started_at"] = 0

                if self.vitals_publisher:
                    # Publish only fields observed in this advertisement. Replaying
                    # cached Temp/SpO2 here would make old clinical values look new.
                    self.vitals_publisher.publish_vitals(logical_mac, extracted, metadata)

                if JSTYLE_VERBOSE_SENSOR_LOGS:
                    print(
                        f"  [JStyle ADV] {logical_mac}: "
                        + ", ".join(f"{k.upper()}={v}" for k, v in extracted.items() if k in ("hr", "spo2", "temp", "batt", "status"))
                    )

        if driver.advertisement_parser:
            extracted = driver.advertisement_parser(logical_mac, advertisement_data)
            if extracted and self.vitals_publisher:
                if logical_mac not in self.device_state:
                    self._init_device_state(logical_mac)
                self.device_state[logical_mac]["last_data_timestamp"] = now
                self.vitals_publisher.publish_sensor_metrics(logical_mac, extracted, metadata)

    async def start_scanner(self) -> bool:
        """Start persistent scanning after reconciling the Bleak and BlueZ states."""
        if self.dual_adapter_enabled:
            results = await asyncio.gather(*(
                self._start_adapter_scanner(address)
                for address in self.adapter_manager.adapters
            ))
            return any(results)
        async with self.scanner_control_lock:
            discovering = await self._get_discovery_status()
            if self.scanner is not None and discovering is not False:
                return True

            if self.scanner is not None or discovering is True:
                print(
                    "[BLE] Reconciling stale scanner state "
                    f"(object={self.scanner is not None}, discovering={discovering})"
                )
                await self._stop_scanner_locked(force_bluez=True)

            try:
                def compatibility_callback(device, advertisement_data):
                    self._detection_callback(device, advertisement_data)
                scanner = BleakScanner(detection_callback=compatibility_callback)
                await asyncio.wait_for(
                    scanner.start(), timeout=BLE_SCANNER_START_TIMEOUT_SECONDS
                )
                self.scanner = scanner
                self.scanner_started_at = time.time()
                print("[BLE] Persistent scanner started")
                return True
            except Exception as e:
                print(f"[BLE] Scanner start failed: {e}")
                self.scanner = None
                self.scanner_started_at = 0.0
                return False

    async def _adapter_discovering(self, adapter_address: str) -> Optional[bool]:
        runtime = self.adapter_manager.adapters.get(normalize_address(adapter_address))
        if not runtime:
            return None
        try:
            proc = await asyncio.create_subprocess_shell(
                f"busctl get-property org.bluez /org/bluez/{runtime.interface} "
                "org.bluez.Adapter1 Discovering",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=3.0)
            if proc.returncode != 0:
                return None
            value = stdout.decode(errors="ignore").strip().lower()
            return True if value.endswith("true") else False if value.endswith("false") else None
        except Exception:
            return None

    async def _start_adapter_scanner(self, adapter_address: str) -> bool:
        address = normalize_address(adapter_address)
        runtime = self.adapter_manager.adapters.get(address)
        if runtime and not runtime.healthy and runtime.recovery_until <= time.time():
            runtime.healthy = True
        if not runtime or not runtime.powered or not runtime.healthy:
            return False
        lock = self.scanner_locks[address]
        async with lock:
            existing = self.scanners.get(address)
            discovering = await self._adapter_discovering(address)
            if existing is not None and discovering is not False:
                return True
            if existing is not None:
                await self._stop_adapter_scanner_locked(address, force_bluez=True)
            try:
                scanner = BleakScanner(
                    detection_callback=self._adapter_detection_callback(address),
                    bluez={"adapter": runtime.interface},
                )
                await asyncio.wait_for(
                    scanner.start(), timeout=BLE_SCANNER_START_TIMEOUT_SECONDS
                )
                self.scanners[address] = scanner
                started_at = time.time()
                self.scanner_started_at_by_adapter[address] = started_at
                # A restarted scanner needs one full stale interval to receive an
                # advertisement. Without this grace period the watchdog sees the
                # old timestamp and immediately tears the new scanner down again.
                self.scanner_recovery_until_by_adapter[address] = (
                    started_at + BLE_SCANNER_RECOVERY_COOLDOWN_SECONDS
                )
                runtime.healthy = True
                self.scanner = next(iter(self.scanners.values()), None)
                self.scanner_started_at = min(self.scanner_started_at_by_adapter.values())
                print(f"[BLE] Persistent scanner started on {runtime.interface} ({address})")
                return True
            except Exception as error:
                runtime.healthy = False
                runtime.recovery_until = time.time() + 60
                print(f"[BLE] Scanner start failed on {runtime.interface}: {error}")
                return False

    async def stop_scanner(self):
        """Stop persistent scanning and leave both local and BlueZ state clean."""
        if self.dual_adapter_enabled:
            for address in list(self.scanners):
                await self._stop_adapter_scanner(address)
            return
        async with self.scanner_control_lock:
            await self._stop_scanner_locked(force_bluez=False)

    async def _stop_adapter_scanner(self, adapter_address: str, force_bluez: bool = False):
        address = normalize_address(adapter_address)
        async with self.scanner_locks[address]:
            await self._stop_adapter_scanner_locked(address, force_bluez)

    async def _stop_adapter_scanner_locked(self, adapter_address: str, force_bluez: bool):
        address = normalize_address(adapter_address)
        runtime = self.adapter_manager.adapters.get(address)
        scanner = self.scanners.pop(address, None)
        self.scanner_started_at_by_adapter.pop(address, None)
        stop_failed = False
        stop_in_progress = False
        if scanner:
            try:
                await asyncio.wait_for(scanner.stop(), timeout=5.0)
                print(f"[BLE] Scanner stopped on {runtime.interface}")
            except Exception as error:
                stop_failed = True
                stop_in_progress = "InProgress" in str(error)
                print(f"[BLE] Scanner stop error on {runtime.interface}: {error}")
        discovering = await self._adapter_discovering(address)
        if stop_in_progress:
            # Bleak already asked BlueZ to stop. Sending StopDiscovery while that
            # operation is still pending perpetuates org.bluez.Error.InProgress.
            deadline = time.monotonic() + 2.0
            while discovering is True and time.monotonic() < deadline:
                await asyncio.sleep(0.25)
                discovering = await self._adapter_discovering(address)
        should_force_bluez_stop = (
            discovering is True
            or (force_bluez and discovering is not False)
            or (stop_failed and not stop_in_progress)
        )
        if runtime and should_force_bluez_stop:
            await self._run_shell(
                f"busctl call org.bluez /org/bluez/{runtime.interface} "
                "org.bluez.Adapter1 StopDiscovery",
                timeout=5.0,
            )
            # StopDiscovery is asynchronous in BlueZ. Give it a short bounded
            # settle period before a new Bleak discovery client is created.
            deadline = time.monotonic() + 3.0
            while time.monotonic() < deadline:
                if await self._adapter_discovering(address) is not True:
                    break
                await asyncio.sleep(0.25)
        self.scanner = next(iter(self.scanners.values()), None)
        self.scanner_started_at = min(self.scanner_started_at_by_adapter.values(), default=0.0)

    async def _stop_scanner_locked(self, force_bluez: bool):
        scanner = self.scanner
        # Clear first so concurrent controller checks never trust a scanner that
        # is stopping or whose BlueZ call failed with InProgress.
        self.scanner = None
        self.scanner_started_at = 0.0
        stop_failed = False
        if scanner:
            try:
                await asyncio.wait_for(scanner.stop(), timeout=5.0)
                print("[BLE] Scanner stopped")
            except Exception as e:
                print(f"[BLE] Scanner stop error: {e}")
                stop_failed = True

        discovering = await self._get_discovery_status()
        if force_bluez or stop_failed or discovering is True:
            await self._run_shell(
                "busctl call org.bluez /org/bluez/hci0 org.bluez.Adapter1 StopDiscovery",
                timeout=5.0,
            )
            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline:
                if await self._get_discovery_status(force=True) is not True:
                    break
                await asyncio.sleep(0.25)

    async def _wait_for_fresh_candidate(
        self,
        mac: str,
        newer_than: Optional[float] = None,
    ) -> Optional[dict]:
        """Return a recently advertised device object, never a stale BlueZ path."""
        if self.dual_adapter_enabled:
            deadline = time.monotonic() + BLE_REDISCOVERY_TIMEOUT
            while time.monotonic() < deadline and not self.shutdown_event.is_set():
                selected = self.adapter_manager.choose(mac, BLE_CONNECT_CANDIDATE_MAX_AGE)
                if selected:
                    address, candidate, score = selected
                    runtime = self.adapter_manager.adapters[address]
                    return {
                        "device": candidate.device,
                        "rssi": candidate.median_rssi,
                        "seen": candidate.seen,
                        "ble_address": candidate.ble_address,
                        "local_name": candidate.local_name,
                        "match_priority": candidate.match_priority,
                        "adapter_address": address,
                        "adapter_interface": runtime.interface,
                        "adapter_score": score,
                    }
                await self.start_scanner()
                await asyncio.sleep(0.25)
            return None
        if not self.scanner and not self.shutdown_event.is_set():
            if not await self.start_scanner():
                return None

        deadline = time.monotonic() + BLE_REDISCOVERY_TIMEOUT
        while time.monotonic() < deadline and not self.shutdown_event.is_set():
            info = self.discovered.get(mac)
            if info:
                seen = float(info.get("seen") or 0)
                age = max(0.0, time.time() - seen)
                required_seen = max(float(newer_than or 0), self.scanner_started_at)
                is_new_enough = seen >= required_seen
                if age <= BLE_CONNECT_CANDIDATE_MAX_AGE and is_new_enough:
                    return info
            await asyncio.sleep(0.25)
        return None

    # ----------------------------------------------------------
    # BLE CONNECTION MANAGEMENT
    # ----------------------------------------------------------

    @staticmethod
    def _consume_background_task(task: asyncio.Task) -> None:
        """Retrieve a detached task result so late D-Bus errors are not leaked."""
        try:
            task.result()
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

    async def _connect_client_with_deadline(self, client: BleakClient) -> None:
        """Connect with a hard parent deadline even if Bleak cancellation stalls.

        Bleak's ``timeout`` option is passed through to its BlueZ backend, but a
        wedged D-Bus operation can outlive that timeout.  ``asyncio.wait`` lets
        the controller move on without waiting indefinitely for cancellation.
        """
        connect_task = asyncio.create_task(client.connect(), name="ble-gatt-connect")
        try:
            done, _ = await asyncio.wait(
                {connect_task}, timeout=BLE_CONNECT_TIMEOUT
            )
            if connect_task not in done:
                connect_task.cancel()
                connect_task.add_done_callback(self._consume_background_task)
                raise asyncio.TimeoutError(
                    f"GATT connect exceeded {BLE_CONNECT_TIMEOUT:.1f}s"
                )
            connect_task.result()
        except asyncio.CancelledError:
            if not connect_task.done():
                connect_task.cancel()
                connect_task.add_done_callback(self._consume_background_task)
            raise

    async def _cleanup_failed_connect(self, client, ble_address: str) -> None:
        """Best-effort cleanup after a timed-out or half-open BlueZ connect."""
        if client is not None:
            try:
                if client.is_connected:
                    await asyncio.wait_for(
                        client.disconnect(), timeout=BLE_CONNECT_CLEANUP_TIMEOUT
                    )
            except Exception as error:
                print(f"    [BLE] Timed-out client cleanup failed: {error}")

        address = normalize_address(ble_address)
        if re.fullmatch(r"[0-9A-F]{2}(?::[0-9A-F]{2}){5}", address):
            await self._run_shell(
                f"bluetoothctl disconnect {address}",
                timeout=BLE_CONNECT_CLEANUP_TIMEOUT,
            )

    async def _restore_scanner_after_connect_attempt(
        self, adapter_address: str
    ) -> None:
        """Restore discovery after every bounded connection setup outcome."""
        if self.shutdown_event.is_set() or not self._connection_budget_has_capacity():
            return
        try:
            address = normalize_address(adapter_address)
            if self.dual_adapter_enabled and address:
                runtime = self.adapter_manager.adapters.get(address)
                if (
                    runtime
                    and runtime.powered
                    and runtime.active_connections
                    < self.adapter_manager.max_connections_per_adapter
                    and address not in self.scanners
                ):
                    await self._start_adapter_scanner(address)
            elif not self.scanner:
                await self.start_scanner()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # The watchdog provides a second recovery path.  Never let scanner
            # restoration failure strand the main controller task.
            print(f"[BLE] Scanner restore after connect attempt failed: {error}")

    async def connect_and_monitor(self, mac: str, ble_device):
        """Connect to a device and start monitoring, with retry logic."""
        if not self._is_registered_for_connection(mac):
            self.discovered.pop(mac, None)
            return
        state = self.device_state[mac]
        rssi = self.discovered.get(mac, {}).get("rssi")
        device_type = self.device_registry.device_metadata.get(mac, {}).get("device_type", "wearos")
        driver = DRIVER_REGISTRY.get(device_type)

        info = self.discovered.get(mac, {})
        ble_address = info.get("ble_address", mac)
        local_name = info.get("local_name", "")
        print(f"[BLE] Connecting to {mac} (BLE={ble_address}, name={local_name}, RSSI={rssi} dBm)...")

        # A weak JStyle device must not monopolize the single adapter while
        # other registered devices are waiting. Wear OS keeps the wider retry
        # allowance because its rotating address may need one rediscovery.
        max_retry = BLE_JSTYLE_ATTEMPTS_PER_TURN if driver.mode == DRIVER_MODE_JSTYLE else BLE_CONNECT_RETRY_MAX
        newer_than = None
        state["last_connection_attempt"] = time.time()
        self.vitals_publisher.publish_activity(mac, "connecting", self.device_registry.device_metadata.get(mac, {}) if self.device_registry else {})

        for attempt in range(1, max_retry + 1):
            if self.shutdown_event.is_set() or not self._is_registered_for_connection(mac):
                self.discovered.pop(mac, None)
                return

            print(f"[BLE] Connect attempt {attempt}/{max_retry} for {mac}")

            # A BleakDevice contains a BlueZ object path that becomes invalid
            # after scan stop/start cycles. Require a fresh advertisement before
            # every retry instead of repeatedly using the same dead object.
            current_info = await self._wait_for_fresh_candidate(mac, newer_than)
            if not current_info:
                print(
                    f"[BLE] {mac}: no fresh advertisement within "
                    f"{BLE_REDISCOVERY_TIMEOUT:.1f}s; deferring connection"
                )
                break
            if not self._is_registered_for_connection(mac):
                self.discovered.pop(mac, None)
                return

            candidate_device = current_info.get("device", ble_device)
            candidate_address = current_info.get("ble_address", ble_address)
            if candidate_address != ble_address:
                ble_address = candidate_address
                print(f"    [BLE] Refreshed BLE address: {ble_address}")
            candidate_seen = float(current_info.get("seen") or 0)
            adapter_address = normalize_address(current_info.get("adapter_address", ""))
            runtime = self.adapter_manager.adapters.get(adapter_address)
            adapter_interface = runtime.interface if runtime else None
            state["adapter_address"] = adapter_address
            state["cycle_data_received"] = False
            state["connecting"] = True
            state["connect_started_at"] = time.time()
            state["connect_deadline"] = (
                state["connect_started_at"]
                + BLE_CONNECT_TIMEOUT
                + GATT_SETUP_TIMEOUT
                + BLE_CONNECT_CLEANUP_TIMEOUT
            )
            client = None

            try:
                # Pause discovery while BlueZ establishes the connection and
                # discovers services.  Mark the setup first so the independent
                # watchdog cannot restart this adapter's scanner mid-connect.
                if self.dual_adapter_enabled and adapter_address:
                    await self._stop_adapter_scanner(adapter_address)
                elif self.scanner:
                    await self.stop_scanner()
                    await asyncio.sleep(1.0)

                async with self._lock_for_device(mac):
                    client_options = {
                        "timeout": BLE_CONNECT_TIMEOUT,
                        "bluez": {"adapter": adapter_interface} if adapter_interface else {},
                    }
                    if driver.mode == DRIVER_MODE_WEAROS:
                        # Keep this as close as possible to the direct Wear OS test that works.
                        # Some Android/Wear OS peripherals disconnect during service discovery
                        # when a BlueZ disconnected_callback is registered too early.
                        client = BleakClient(candidate_device, **client_options)
                    else:
                        client = BleakClient(
                            candidate_device,
                            disconnected_callback=self._on_disconnect_callback(mac),
                            **client_options,
                        )
                    await self._connect_client_with_deadline(client)

                    if not client.is_connected:
                        raise BleakError("connect returned without an active link")

                    # The patient may have been unpaired while BlueZ was inside
                    # the bounded connect call. Do not start a monitor for it.
                    if not self._is_registered_for_connection(mac):
                        print(
                            f"[BLE] {mac}: patient assignment removed during "
                            "connection setup; disconnecting"
                        )
                        await self._cleanup_failed_connect(client, candidate_address)
                        self.discovered.pop(mac, None)
                        return

                    if adapter_address:
                        self.adapter_manager.record_connect_result(mac, adapter_address, True)
                        self.adapter_manager.adapters[adapter_address].active_connections += 1
                    self.inprogress_error_counter = 0
                    print(
                        f"[BLE] Connected to {mac} (attempt {attempt}, "
                        f"adapter={adapter_interface or 'default'})"
                    )
                    state["connected"] = True
                    state["fail_count"] = 0
                    connected_at = time.time()
                    state["connected_time"] = connected_at
                    # Never inherit a stale timestamp from a previous session.
                    state["last_data_timestamp"] = connected_at
                    state["monitor_phase"] = "gatt_setup"
                    state["phase_started_at"] = connected_at
                    state["watchdog_deadline"] = connected_at + DATA_RECEIVE_TIMEOUT
                    self.recovery_attempt = 0

                    # Start monitoring only after the link itself is confirmed.
                    monitor_by_mode = {
                        DRIVER_MODE_WEAROS: self._keep_monitoring_wearos,
                        DRIVER_MODE_JSTYLE: self._keep_monitoring,
                        DRIVER_MODE_STANDARD_GATT: self._keep_monitoring_standard_gatt,
                    }
                    monitor = monitor_by_mode.get(driver.mode)
                    if monitor is None:
                        raise RuntimeError(
                            f"Device driver {device_type} does not support a GATT connection"
                        )
                    ready_event = asyncio.Event()
                    state["monitor_ready_event"] = ready_event
                    state["monitor_setup_error"] = None
                    state["task"] = asyncio.create_task(monitor(client, mac))

                    # Keep GATT setup serialized until notification subscription
                    # is complete.  The wait is independently bounded.
                    try:
                        await asyncio.wait_for(
                            ready_event.wait(), timeout=GATT_SETUP_TIMEOUT
                        )
                    except asyncio.TimeoutError:
                        print(f"[BLE] {mac}: GATT notification setup timed out")
                        state["task"].cancel()
                        return

                    if state.get("monitor_setup_error"):
                        print(
                            f"[BLE] {mac}: GATT setup failed: "
                            f"{state['monitor_setup_error']}"
                        )
                    return

            except asyncio.TimeoutError as error:
                print(
                    f"[BLE] Connect timeout for {mac} (attempt {attempt}): {error}"
                )
                if self.vitals_publisher:
                    self.vitals_publisher.publish_activity(
                        mac,
                        "connect_timeout",
                        self.device_registry.device_metadata.get(mac, {})
                        if self.device_registry
                        else {},
                    )
                if adapter_address:
                    self.adapter_manager.record_connect_result(
                        mac, adapter_address, False
                    )
                newer_than = candidate_seen
                self.discovered.pop(mac, None)
                await self._cleanup_failed_connect(client, candidate_address)

            except BleakError as e:
                err_str = str(e)
                print(f"[BLE] Connect error for {mac} (attempt {attempt}): {e}")
                if self.vitals_publisher:
                    self.vitals_publisher.publish_activity(mac, "gatt_error", self.device_registry.device_metadata.get(mac, {}) if self.device_registry else {})
                if adapter_address:
                    self.adapter_manager.record_connect_result(mac, adapter_address, False)

                if "not found" in err_str.lower():
                    # Force the next attempt to obtain a new BlueZ object path.
                    newer_than = candidate_seen
                    self.discovered.pop(mac, None)

                if "InProgress" in err_str:
                    self.inprogress_error_counter += 1
                    threshold = 3
                    print(f"    [BLE] InProgress counter: {self.inprogress_error_counter}/{threshold}")

                    if self.inprogress_error_counter >= threshold:
                        self.inprogress_error_counter = 0
                        print("[BLE] Recovering from InProgress state...")
                        await self._recover_from_inprogress()

                    break

            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[BLE] Connect exception for {mac} (attempt {attempt}): {e}")
                if self.vitals_publisher:
                    self.vitals_publisher.publish_activity(
                        mac,
                        "gatt_error",
                        self.device_registry.device_metadata.get(mac, {})
                        if self.device_registry
                        else {},
                    )
                if adapter_address:
                    self.adapter_manager.record_connect_result(mac, adapter_address, False)
            finally:
                state["connecting"] = False
                state["connect_started_at"] = 0
                state["connect_deadline"] = 0
                await self._restore_scanner_after_connect_attempt(adapter_address)

            if attempt < max_retry:
                backoff = BLE_CONNECT_RETRY_DELAY * attempt
                print(f"    [BLE] Waiting {backoff:.1f}s before retry...")
                if not self.scanner and not self.shutdown_event.is_set():
                    await self.start_scanner()
                await asyncio.sleep(backoff)

        # All retries failed
        state["fail_count"] += 1
        cooldown = self._retry_backoff(state["fail_count"])
        print(f"[BLE] {mac}: Failed after {max_retry} attempts, fail_count={state['fail_count']}")
        state["cooldown_until"] = time.time() + cooldown
        print(f"[BLE] {mac}: Deferring next attempt for {cooldown:.0f}s")

    def _on_disconnect_callback(self, mac: str):
        """Callback when device disconnects."""
        def _cb(_client):
            print(f"[BLE] {mac} disconnected")
            if mac in self.device_state:
                self.device_state[mac]["connected"] = False
                self.device_state[mac]["connected_time"] = None
                self.device_state[mac]["monitor_phase"] = "idle"
                self.device_state[mac]["phase_started_at"] = 0
                self.device_state[mac]["watchdog_deadline"] = 0
        return _cb

    async def _start_jstyle_notifications(self, client: BleakClient, mac: str) -> None:
        """Subscribe with one bounded retry for transient BlueZ/GATT failures."""
        callback = lambda _ch, data: self._on_notification(mac, data)
        for attempt in range(JSTYLE_COMMAND_RETRIES + 1):
            try:
                await client.start_notify(CHAR_RX, callback)
                return
            except Exception as error:
                can_retry = (
                    attempt < JSTYLE_COMMAND_RETRIES
                    and bool(getattr(client, "is_connected", True))
                    and self._is_transient_gatt_error(error)
                )
                if not can_retry:
                    raise
                print(
                    f"    ⚠️ {mac}: transient notify setup error; "
                    f"retrying ({attempt + 1}/{JSTYLE_COMMAND_RETRIES}): {error}"
                )
                if JSTYLE_COMMAND_RETRY_DELAY:
                    await asyncio.sleep(JSTYLE_COMMAND_RETRY_DELAY)

    # ----------------------------------------------------------
    # KEEP MONITORING (Wear OS GATT)
    # ----------------------------------------------------------

    async def _keep_monitoring(self, client: BleakClient, mac: str):
        """Main monitoring loop for an iStyle/JStyle device (command-based protocol)."""
        state = self.device_state[mac]
        session_adapter_result = None
        metadata = (
            self.device_registry.device_metadata.get(mac, {})
            if self.device_registry is not None else {}
        )

        try:
            print(f"[BLE] Starting JStyle/iStyle monitoring for {mac}")
            state["monitor_failed"] = False
            self._set_monitor_phase(mac, "gatt_setup", DATA_RECEIVE_TIMEOUT)
            state["cycle_started_at"] = time.time()

            # Enable notifications on RX characteristic
            await self._start_jstyle_notifications(client, mac)
            ready_event = state.get("monitor_ready_event")
            if ready_event:
                ready_event.set()

            # Wait for notification setup
            await asyncio.sleep(2.0)

            if state.get("is_wearing") == 0:
                state["wear_probe_active"] = True
                state["stop_measurement_requested"] = False
                state["off_wrist_confirmation_count"] = 0
                state["off_wrist_confirmation_started_at"] = 0
                self._set_monitor_phase(mac, "wear_probe", JSTYLE_WEAR_PROBE_TIMEOUT)
                print(
                    f"[BLE] {mac}: short wear probe started "
                    f"(timeout={JSTYLE_WEAR_PROBE_TIMEOUT:.0f}s)"
                )

            # Phase 1: HR + Temp loop
            completed_cycles = 0
            first_sample_retries = 0
            while client.is_connected and not self.shutdown_event.is_set():
                await self._acquire_measurement_slot(mac)
                phase_result = await self._phase1_hr_temp(client, mac, metadata)

                if not client.is_connected or self.shutdown_event.is_set():
                    self._release_measurement_slot(mac)
                    break
                if phase_result == "off_wrist":
                    print(f"[BLE] {mac}: off-wrist confirmed; ending measurement immediately")
                    # Expected lack of skin contact is not a sensor failure.
                    self._release_measurement_slot(mac, record_result=False)
                    break
                if phase_result == "no_samples":
                    if first_sample_retries < JSTYLE_FIRST_SAMPLE_RETRIES:
                        first_sample_retries += 1
                        state["last_result"] = "first_sample_retry"
                        print(
                            f"[BLE] {mac}: no HR/Temp samples; restarting stream "
                            f"in the same connection ({first_sample_retries}/"
                            f"{JSTYLE_FIRST_SAMPLE_RETRIES})"
                        )
                        if JSTYLE_ENABLE_MEASURE_COMMANDS and client.is_connected:
                            try:
                                await self._write_jstyle_command(
                                    client, mac, "HR/Temp retry stop", 0x09, 0x00, 0x00, 0x00
                                )
                            except Exception:
                                pass
                        # Yield the adapter measurement slot between retries so
                        # one silent watch cannot block every queued watch.
                        self._release_measurement_slot(mac, record_result=False)
                        if JSTYLE_FIRST_SAMPLE_RETRY_DELAY:
                            await asyncio.sleep(JSTYLE_FIRST_SAMPLE_RETRY_DELAY)
                        continue
                    print(
                        f"[BLE] {mac}: no HR/Temp samples after retries; "
                        "ending cycle before SpO2"
                    )
                    session_adapter_result = False
                    self._release_measurement_slot(mac)
                    break
                if phase_result == "sensor_no_reading":
                    print(
                        f"[BLE] {mac}: sensor responded without a clinical "
                        "HR/Temp reading; ending cycle without redundant retries"
                    )
                    self._release_measurement_slot(mac)
                    break

                first_sample_retries = 0

                # --- Interleaved: release slot between Phase1 and Phase2 ---
                # Phase1 (HR/Temp) is complete. Release the measurement slot so
                # other connected devices can start their Phase1 or Phase2 while
                # this device waits for a fresh slot before SpO2. The GATT
                # connection stays open; notifications continue flowing.
                self._release_measurement_slot(mac)

                if not client.is_connected or self.shutdown_event.is_set():
                    break

                # Phase 2: retry a silent optical stream once, yielding the
                # per-adapter measurement slot between attempts.
                spo2_received = await self._phase2_spo2_with_retries(client, mac)

                if not client.is_connected or self.shutdown_event.is_set():
                    break

                if not spo2_received:
                    state["spo2_timeout_count"] = state.get("spo2_timeout_count", 0) + 1
                    print(
                        f"[BLE] {mac}: SpO2 did not verify — keeping connection "
                        "and resuming HR/Temp "
                        f"(count={state['spo2_timeout_count']})"
                    )
                else:
                    state["spo2_timeout_count"] = 0

                completed_cycles += 1
                state["completed_cycles"] = state.get("completed_cycles", 0) + 1
                if (
                    not spo2_received
                    and self._spo2_failure_is_retryable(state)
                ):
                    # A fresh GATT session is safer than repeatedly issuing
                    # commands into a stream that remained silent after retry.
                    session_adapter_result = False
                    print(
                        f"[BLE] {mac}: SpO2 retries exhausted; rotating the "
                        "GATT session"
                    )
                    break
                if not JSTYLE_PERSISTENT_STREAMING and completed_cycles >= JSTYLE_CYCLES_PER_CONNECTION:
                    state["monitor_fail_count"] = 0
                    session_adapter_result = True
                    cycle_seconds = max(0.0, time.time() - float(state.get("cycle_started_at") or time.time()))
                    print(
                        f"[BLE] {mac}: completed {completed_cycles} measurement cycle(s); "
                        f"rotating adapter slot (cycle_seconds={cycle_seconds:.1f})"
                    )
                    break
                if JSTYLE_PERSISTENT_STREAMING:
                    state["monitor_fail_count"] = 0
                    state["last_result"] = "cycle_complete" if spo2_received else state.get("spo2_quality", "timeout")
                    if JSTYLE_SPO2_RESTART_DELAY:
                        await asyncio.sleep(JSTYLE_SPO2_RESTART_DELAY)

        except Exception as e:
            session_adapter_result = False
            state["monitor_setup_error"] = str(e)
            state["monitor_failed"] = True
            state["monitor_fail_count"] = state.get("monitor_fail_count", 0) + 1
            if state["monitor_fail_count"] >= 3:
                self.vitals_publisher.publish_activity(mac, "hardware_hung", self.device_registry.device_metadata.get(mac, {}) if self.device_registry else {})
            print(f"[BLE] Monitoring error for {mac}: {e}")
        finally:
            self._release_measurement_slot(mac)
            ready_event = state.get("monitor_ready_event")
            if ready_event:
                ready_event.set()
            print(f"[BLE] Monitoring ended for {mac}")
            # Safe disconnect: acquire lock first to prevent race with scan/connect
            lock_acquired = False
            try:
                device_lock = self._lock_for_device(mac)
                await asyncio.wait_for(
                    device_lock.acquire(), timeout=GATT_SETUP_TIMEOUT + 5.0
                )
                lock_acquired = True
            except asyncio.TimeoutError:
                print(f"    ⚠️ {mac}: adapter cleanup lock timed out")
            except Exception as e:
                print(f"    ⚠️ {mac}: adapter cleanup lock error: {type(e).__name__}: {e}")

            try:
                if client.is_connected:
                    try:
                        await self._write_jstyle_command(client, mac, "HR/Temp stop", 0x09, 0x00, 0x00, 0x00)
                    except Exception:
                        pass
                    print(f"    ⏳ {mac} disconnecting safely...")
                    await asyncio.sleep(1.0)
                    await asyncio.wait_for(client.disconnect(), timeout=5.0)
            except Exception as e:
                print(f"    ⚠️ Safe disconnect error {mac}: {e}")
            finally:
                if lock_acquired:
                    device_lock.release()
                address = normalize_address(state.get("adapter_address", ""))
                if address in self.adapter_manager.adapters:
                    runtime = self.adapter_manager.adapters[address]
                    runtime.active_connections = max(0, runtime.active_connections - 1)
                    if (
                        session_adapter_result is None
                        and not client.is_connected
                        and not self.shutdown_event.is_set()
                        and state.get("is_wearing") != 0
                    ):
                        session_adapter_result = False
                    if session_adapter_result is not None:
                        self.adapter_manager.record_gatt_result(
                            mac, address, session_adapter_result
                        )
                # Short delay to let BlueZ cleanup before next scan
                await asyncio.sleep(1.5)
                state["connected"] = False
                state["task"] = None
                cooldown = (
                    self._retry_backoff(state.get("monitor_fail_count", 1))
                    if state.get("monitor_failed")
                    else JSTYLE_ROTATION_COOLDOWN
                )
                cooldown = self._jstyle_rotation_cooldown(state, cooldown)
                state["cooldown_until"] = max(
                    float(state.get("cooldown_until") or 0),
                    time.time() + cooldown,
                )
                if state.get("is_wearing") == 0:
                    state["off_wrist_probe_after"] = state["cooldown_until"]
                state["wear_probe_active"] = False
                state["monitor_phase"] = "idle"
                state["phase_started_at"] = 0
                state["watchdog_deadline"] = 0

    def _on_notification(self, mac: str, data: bytes):
        """Handle notification from RX characteristic."""
        state = self.device_state.get(mac, {})
        state["last_data_timestamp"] = time.time()
        raw_hex = data.hex()
        if JSTYLE_DEBUG_UNPARSED:
            print(f"  [JStyle RAW] {mac}: {raw_hex}")

        extracted = JStyleDeviceHandler.parse_vitals(mac, data)
        if not extracted:
            if JSTYLE_DEBUG_UNPARSED:
                print(f"  [JStyle] {mac}: unparsed packet {raw_hex}")
            return

        packet_received_at = time.time()
        notification_event = state.get("notification_event")
        if notification_event:
            notification_event.set()
        if extracted.get("raw_provider") == "jstyle_0x28":
            state["spo2_last_progress_at"] = packet_received_at
            progress_event = state.get("spo2_progress_event")
            if progress_event:
                progress_event.set()

        if state.get("monitor_phase") == "hr_temp":
            if extracted.get("raw_provider") == "jstyle_0x09":
                # HR=0 is not a clinical sample, but it proves the watch and
                # optical sensor are responding. Give that active stream the
                # full phase window instead of restarting it at the transport
                # first-packet timeout.
                state["phase_hr_temp_packet_seen"] = True
            if extracted.get("status") == 1:
                if "hr" in extracted:
                    if not state.get("phase_first_hr_at"):
                        state["phase_first_hr_at"] = packet_received_at
                    state.setdefault("phase_hr_samples", []).append(int(extracted["hr"]))
                    state["phase_hr_samples"] = state["phase_hr_samples"][-PHASE_1_STABLE_SAMPLES:]
                if "temp" in extracted:
                    if not state.get("phase_first_temp_at"):
                        state["phase_first_temp_at"] = packet_received_at
                    state.setdefault("phase_temp_samples", []).append(float(extracted["temp"]))
                    state["phase_temp_samples"] = state["phase_temp_samples"][-PHASE_1_STABLE_SAMPLES:]

        state.setdefault("last_jstyle_vitals", {}).update(extracted)

        raw_status = extracted.get("status")
        
        # ESP32 parity: HR Freeze after SpO2 (30 seconds)
        # The optical sensor takes time to switch back from SpO2 mode, often emitting HR=0
        hr_val = extracted.get("hr")
        last_spo2_end = state.get("last_spo2_end_time", 0)
        now = time.time()
        
        hr_frozen = False
        if hr_val == 0 and last_spo2_end > 0 and (now - last_spo2_end) <= 30.0:
            hr_frozen = True
            
        if hr_frozen:
            # Drop HR to prevent freezing the dashboard to 0
            extracted.pop("hr", None)
            # Prevent triggering off-wrist if it's just the sensor waking up
            temp_val = extracted.get("temp", 0)
            if temp_val > 28.0:
                raw_status = 1
                extracted["status"] = 1
        if raw_status == 1:
            state["off_wrist_confirmation_count"] = 0
            state["off_wrist_confirmation_started_at"] = 0
            state["is_wearing"] = 1
            state["worn_confirmed_since_start"] = True
            state["off_wrist_probe_after"] = 0
            state["wear_probe_active"] = False
            state["stop_measurement_requested"] = False
        elif raw_status == 0:
            connected_time = float(state.get("connected_time") or 0)
            connection_age = max(0.0, packet_received_at - connected_time)
            waiting_for_worn_baseline = (
                not state.get("worn_confirmed_since_start")
                and state.get("is_wearing") != 1
            )
            startup_grace_applies = (
                connected_time > 0
                and connection_age < JSTYLE_STARTUP_OFF_WRIST_GRACE
                and state.get("is_wearing") != 1
            )
            if waiting_for_worn_baseline or startup_grace_applies:
                # If we have a real HR reading (> 0), the device IS worn
                # regardless of what the status byte says. Accept the vitals
                # and promote to worn baseline so future packets flow freely.
                hr_val = extracted.get("hr")
                if hr_val is not None and int(hr_val) > 0:
                    state["worn_confirmed_since_start"] = True
                    state["is_wearing"] = 1
                    state["off_wrist_confirmation_count"] = 0
                    state["off_wrist_confirmation_started_at"] = 0
                    raw_status = 1
                    print(
                        f"  [JStyle] {mac}: auto-confirmed worn via positive HR={hr_val} "
                        f"(connection_age={connection_age:.1f}s)"
                    )
                else:
                    state["off_wrist_confirmation_count"] = 0
                    state["off_wrist_confirmation_started_at"] = 0
                    extracted.pop("status", None)
                    for field in ("hr", "spo2", "temp"):
                        extracted.pop(field, None)
                    print(
                        f"  [JStyle] {mac}: ignoring unconfirmed off-wrist packet "
                        f"(worn_baseline={not waiting_for_worn_baseline}, "
                        f"connection_age={connection_age:.1f}s)"
                    )
                    raw_status = None

        if raw_status == 0:
            confirmation_started = float(state.get("off_wrist_confirmation_started_at") or 0)
            if (
                confirmation_started <= 0
                or packet_received_at - confirmation_started > JSTYLE_OFF_WRIST_CONFIRMATION_WINDOW
            ):
                confirmation_started = packet_received_at
                confirmations = 1
            else:
                confirmations = state.get("off_wrist_confirmation_count", 0) + 1
            state["off_wrist_confirmation_started_at"] = confirmation_started
            state["off_wrist_confirmation_count"] = confirmations
            confirmation_age = max(0.0, packet_received_at - confirmation_started)
            off_wrist_confirmed = (
                confirmations >= JSTYLE_OFF_WRIST_CONFIRMATIONS
                and confirmation_age >= JSTYLE_OFF_WRIST_MIN_CONFIRMATION_SECONDS
            )
            if not off_wrist_confirmed:
                # Optical transitions occasionally emit one status=0 packet.
                # Do not let transient packets blank every dashboard metric.
                extracted.pop("status", None)
                for field in ("hr", "spo2", "temp"):
                    extracted.pop(field, None)
                print(
                    f"  [JStyle] {mac}: off-wrist confirmation "
                    f"{confirmations}/{JSTYLE_OFF_WRIST_CONFIRMATIONS} "
                    f"({confirmation_age:.1f}/{JSTYLE_OFF_WRIST_MIN_CONFIRMATION_SECONDS:.1f}s)"
                )
            else:
                state["is_wearing"] = 0
                state["last_confirmed_off_wrist_at"] = packet_received_at
                state["off_wrist_probe_after"] = packet_received_at + JSTYLE_OFF_WRIST_PROBE_INTERVAL
                state["wear_probe_active"] = False
                state["stop_measurement_requested"] = True
                off_wrist_event = state.get("off_wrist_event")
                if off_wrist_event:
                    off_wrist_event.set()
                if state.get("monitor_phase") == "spo2":
                    # Clear a pending optical result only after off-wrist has
                    # passed both the packet-count and minimum-duration gates.
                    state["spo2_off_wrist_seen"] = True
                    state["spo2_off_wrist_confirmed"] = True
                    state["spo2_candidate"] = 0
                    state["spo2_candidate_count"] = 0
                    state["spo2_samples"] = []
                    state["spo2_ready"] = False

        if "spo2" in extracted:
            candidate = extracted["spo2"]
            if extracted.get("status") != 1:
                state["spo2_off_wrist_seen"] = True
                state["spo2_candidate"] = 0
                state["spo2_candidate_count"] = 0
                state["spo2_samples"] = []
                state["spo2_ready"] = False
            elif state.get("monitor_phase") == "spo2":
                # The J2208A emits only one device-computed final result in
                # byte 3. Progress packets have byte 3=0 and are filtered by
                # the parser, so no host-side warm-up/window gate is needed.
                state["spo2_samples"] = [(candidate, extracted.get("hr"))]
                state["spo2_candidate_count"] = 1
                state["spo2_candidate"] = candidate
                state["last_spo2_value"] = candidate
                state["spo2_ready"] = True
                final_event = state.get("spo2_final_event")
                if final_event:
                    final_event.set()

            # The final result is published only after _phase2_spo2 marks it
            # verified. Never publish an unverified value from this callback.
            extracted.pop("spo2", None)

        if state.get("monitor_phase") == "spo2":
            # Byte 10 in the optical packet is useful only for validating the
            # SpO2 result. Publishing it as live HR causes large artificial jumps.
            extracted.pop("hr", None)
            extracted.pop("temp", None)

        # Clinical values require an explicit wear confirmation in the current
        # packet. Never inherit wear status from an earlier notification.
        if extracted.get("status") != 1:
            for field in ("hr", "spo2", "temp"):
                extracted.pop(field, None)

        # Publish only values observed in this packet. Cached values remain
        # available for diagnostics but are never re-timestamped as fresh data.
        metadata = self.device_registry.device_metadata.get(mac, {})
        self.vitals_publisher.publish_vitals(mac, extracted, metadata)

        # Update per-metric SLA timestamps for scheduler priority
        if "hr" in extracted and extracted.get("status") == 1:
            state["last_hr_at"] = time.time()
        if "temp" in extracted and extracted.get("status") == 1:
            state["last_temp_at"] = time.time()
        if extracted.get("status") == 1 and any(
            key in extracted for key in ("hr", "temp")
        ):
            self._record_device_data_success(mac, extracted)

        parts = []
        if "hr" in extracted:
            parts.append(f"HR={extracted['hr']}")
        if "temp" in extracted:
            parts.append(f"Temp={extracted['temp']}")
        if "spo2" in extracted:
            parts.append(f"SpO2={extracted['spo2']}")
        if "batt" in extracted:
            parts.append(f"Batt={extracted['batt']}")
        if "status" in extracted:
            parts.append(f"Status={extracted['status']}")

        if parts and JSTYLE_VERBOSE_SENSOR_LOGS:
            print(f"  [JStyle] {mac}: {', '.join(parts)}")

    @staticmethod
    def _estimate_jstyle_spo2_round(samples) -> Optional[int]:
        """Return a robust JStyle round estimate or None for a noisy signal."""
        if len(samples) < SPO2_SAMPLES_REQUIRED:
            return None

        recent = samples[-SPO2_SAMPLES_REQUIRED:]
        centre = statistics.median(value for value, _hr in recent)
        inliers = [
            (value, hr) for value, hr in recent
            if abs(value - centre) <= SPO2_SAMPLE_TOLERANCE
        ]
        if len(inliers) < SPO2_MIN_INLIERS:
            return None

        heart_rates = [hr for _value, hr in inliers if hr is not None]
        if len(heart_rates) >= SPO2_MIN_INLIERS and max(heart_rates) - min(heart_rates) > SPO2_HR_TOLERANCE:
            return None

        return int(round(statistics.median(value for value, _hr in inliers)))

    @staticmethod
    def _is_transient_gatt_error(error: Exception) -> bool:
        message = str(error).lower()
        permanent_markers = (
            "not connected", "unknownobject", "not found", "not permitted",
            "authentication", "authorization",
        )
        if any(marker in message for marker in permanent_markers):
            return False
        return any(marker in message for marker in (
            "unlikely error", "inprogress", "in progress", "busy",
            "temporarily unavailable", "operation already in progress",
            "org.bluez.error.failed",
        ))

    async def _write_jstyle_command(
        self,
        client: BleakClient,
        mac: str,
        label: str,
        *values: int,
    ) -> None:
        """Write one valid JStyle command and log the exact transmitted frame."""
        frame = build_jstyle_command(*values)
        address = normalize_address(self.device_state.get(mac, {}).get("adapter_address", ""))
        lock_key = address or "default"
        command_lock = self.command_locks.setdefault(lock_key, asyncio.Lock())
        async with command_lock:
            print(f"  [JStyle TX] {mac} {label}: {frame.hex()}")
            for attempt in range(JSTYLE_COMMAND_RETRIES + 1):
                try:
                    await client.write_gatt_char(CHAR_TX, frame)
                    # Enforce a mandatory delay after every command to prevent watch firmware from crashing
                    # (Addresses SDK requirement: "ห้ามยิงหลาย history command พร้อมกัน")
                    await asyncio.sleep(0.3)
                    return
                except Exception as error:
                    can_retry = (
                        attempt < JSTYLE_COMMAND_RETRIES
                        and bool(getattr(client, "is_connected", True))
                        and self._is_transient_gatt_error(error)
                    )
                    if not can_retry:
                        raise
                    print(
                        f"    ⚠️ {mac}: transient {label} GATT error; "
                        f"retrying command ({attempt + 1}/{JSTYLE_COMMAND_RETRIES}): "
                        f"{error}"
                    )
                    if JSTYLE_COMMAND_RETRY_DELAY:
                        await asyncio.sleep(JSTYLE_COMMAND_RETRY_DELAY)

    async def _keep_monitoring_wearos(self, client: BleakClient, mac: str):
        """Main monitoring loop for a Wear OS device acting as BLE Peripheral."""
        state = self.device_state[mac]

        try:
            print(f"[BLE] Starting Wear OS monitoring for {mac}")
            state["wearos_rx_buffer"] = b""
            state["wearos_rx_buffer_started_at"] = 0
            state["wearos_protocol_error_event"] = asyncio.Event()

            wearos_char = None
            last_services_dump = []

            # Force GATT service discovery before start_notify. Some BlueZ/Bleak
            # connections do not populate the custom Wear OS service immediately.
            for discovery_attempt in range(1, 6):
                await asyncio.sleep(0.5)
                try:
                    services = client.services
                except Exception:
                    get_services = getattr(client, "get_services", None)
                    services = await get_services() if get_services else []

                last_services_dump = []
                for service in services:
                    last_services_dump.append(f"service {service.uuid}")
                    for characteristic in service.characteristics:
                        last_services_dump.append(f"  char {characteristic.uuid} {characteristic.properties}")
                        if str(characteristic.uuid).lower() == WEAROS_VITALS_UUID.lower():
                            wearos_char = characteristic

                if wearos_char:
                    break

                print(f"[WearOS] {mac}: Vitals characteristic not ready (discovery {discovery_attempt}/5)")

            if not wearos_char:
                print(f"[WearOS] {mac}: Available GATT services before failure:")
                for line in last_services_dump:
                    print(f"    {line}")
                raise RuntimeError(f"Characteristic {WEAROS_VITALS_UUID} was not found")

            await client.start_notify(
                wearos_char,
                lambda _ch, data: self._on_wearos_notification(mac, data),
            )
            print(f"[WearOS] {mac}: notify subscribed on {WEAROS_VITALS_UUID}")
            ready_event = state.get("monitor_ready_event")
            if ready_event:
                ready_event.set()

            protocol_error_event = state["wearos_protocol_error_event"]
            while client.is_connected and not self.shutdown_event.is_set():
                try:
                    await asyncio.wait_for(protocol_error_event.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue
                if protocol_error_event.is_set():
                    raise RuntimeError(
                        "WearOS sent repeated malformed JSON frames; reconnecting"
                    )

        except Exception as e:
            state["monitor_setup_error"] = str(e)
            print(f"[WearOS] Monitoring error for {mac}: {e}")
        finally:
            ready_event = state.get("monitor_ready_event")
            if ready_event:
                ready_event.set()
            print(f"[WearOS] Monitoring ended for {mac}")
            lock_acquired = False
            try:
                device_lock = self._lock_for_device(mac)
                await asyncio.wait_for(
                    device_lock.acquire(), timeout=GATT_SETUP_TIMEOUT + 5.0
                )
                lock_acquired = True
            except asyncio.TimeoutError:
                print(f"    ⚠️ {mac}: adapter cleanup lock timed out")
            except Exception as e:
                print(f"    ⚠️ {mac}: adapter cleanup lock error: {type(e).__name__}: {e}")

            try:
                if client.is_connected:
                    try:
                        await client.stop_notify(WEAROS_VITALS_UUID)
                    except Exception:
                        pass
                    print(f"    ⏳ {mac} disconnecting safely...")
                    await asyncio.wait_for(client.disconnect(), timeout=5.0)
            except Exception as e:
                print(f"    ⚠️ WearOS safe disconnect error {mac}: {e}")
            finally:
                if lock_acquired:
                    device_lock.release()
                address = normalize_address(state.get("adapter_address", ""))
                if address in self.adapter_manager.adapters:
                    runtime = self.adapter_manager.adapters[address]
                    runtime.active_connections = max(0, runtime.active_connections - 1)
                await asyncio.sleep(1.5)
                state["connected"] = False
                state["task"] = None
                state["cooldown_until"] = time.time() + WEAROS_RECONNECT_COOLDOWN
                state["monitor_phase"] = "idle"
                state["phase_started_at"] = 0
                state["watchdog_deadline"] = 0
                # Wear OS uses a rotating BLE address. Never reconnect with a
                # stale BlueZ object path; continuous scanning will repopulate it.
                self.discovered.pop(mac, None)

    def _on_wearos_notification(self, mac: str, data: bytes):
        """Reassemble bounded JSON frames and publish Wear OS vitals."""
        state = self.device_state.get(mac, {})
        now = time.time()
        state["last_data_timestamp"] = now
        if JSTYLE_VERBOSE_SENSOR_LOGS:
            print(f"  [WearOS RAW] {mac}: {data.decode('utf-8', errors='ignore')}")

        buffered = bytes(state.get("wearos_rx_buffer") or b"")
        buffer_started_at = float(
            state.get("wearos_rx_buffer_started_at") or 0
        )
        if (
            buffered
            and buffer_started_at
            and now - buffer_started_at > WEAROS_RX_BUFFER_TIMEOUT_SECONDS
        ):
            print(f"[WearOS] {mac}: discarded stale fragmented JSON frame")
            buffered = b""
            buffer_started_at = 0

        if not buffered:
            buffer_started_at = now
        buffered += bytes(data).strip(b"\x00")
        frames, remainder = WearOSDeviceHandler.extract_json_frames(buffered)
        if len(remainder) > WEAROS_RX_BUFFER_MAX_BYTES:
            print(
                f"[WearOS] {mac}: discarded oversized fragmented JSON frame "
                f"({len(remainder)} bytes)"
            )
            remainder = b""

        state["wearos_rx_buffer"] = remainder
        state["wearos_rx_buffer_started_at"] = (
            now if remainder else 0
        )

        for frame in frames:
            extracted = WearOSDeviceHandler.parse_vitals(
                mac, frame, log_errors=False
            )
            if not extracted:
                streak = state.get("wearos_parse_error_streak", 0) + 1
                state["wearos_parse_error_streak"] = streak
                state["wearos_parse_error_count"] = (
                    state.get("wearos_parse_error_count", 0) + 1
                )
                last_log = float(state.get("wearos_last_parse_error_log") or 0)
                if (
                    streak == 1
                    or streak >= WEAROS_MAX_CONSECUTIVE_PARSE_ERRORS
                    or now - last_log >= WEAROS_PARSE_ERROR_LOG_INTERVAL
                ):
                    print(
                        f"[WearOS] {mac}: malformed JSON frame rejected "
                        f"(streak={streak}/{WEAROS_MAX_CONSECUTIVE_PARSE_ERRORS}, "
                        f"bytes={len(frame)})"
                    )
                    state["wearos_last_parse_error_log"] = now
                if streak >= WEAROS_MAX_CONSECUTIVE_PARSE_ERRORS:
                    state["wearos_parse_error_streak"] = 0
                    protocol_error_event = state.get("wearos_protocol_error_event")
                    if protocol_error_event:
                        protocol_error_event.set()
                continue
            state["wearos_parse_error_streak"] = 0
            self._record_device_data_success(mac, extracted)
            state["wearos_last_vitals_at"] = now
            metadata = self.device_registry.device_metadata.get(mac, {})
            self.vitals_publisher.publish_vitals(mac, extracted, metadata)

            parts = []
            if "hr" in extracted:
                parts.append(f"HR={extracted['hr']}")
            if "temp" in extracted:
                parts.append(f"Temp={extracted['temp']}")
            if "spo2" in extracted:
                parts.append(f"SpO2={extracted['spo2']}")
            if "batt" in extracted:
                parts.append(f"Batt={extracted['batt']}")
            if "status" in extracted:
                parts.append(f"Status={extracted['status']}")

            if parts and JSTYLE_VERBOSE_SENSOR_LOGS:
                print(f"  [WearOS] {mac}: {', '.join(parts)}")

    async def _keep_monitoring_standard_gatt(self, client: BleakClient, mac: str):
        """Subscribe to documented Bluetooth SIG health characteristics only."""
        state = self.device_state[mac]
        subscribed = []
        battery_characteristic = None

        try:
            print(f"[Standard GATT] Starting monitoring for {mac}")
            self._set_monitor_phase(mac, "gatt_setup", DATA_RECEIVE_TIMEOUT)

            try:
                services = client.services
            except Exception:
                get_services = getattr(client, "get_services", None)
                services = await get_services() if get_services else []

            supported = []
            for service in services:
                for characteristic in service.characteristics:
                    characteristic_uuid = StandardGATTDeviceHandler.canonical_uuid(
                        characteristic.uuid
                    )
                    if characteristic_uuid not in StandardGATTDeviceHandler.SUPPORTED_CHARACTERISTICS:
                        continue

                    properties = {
                        str(value).strip().lower()
                        for value in (getattr(characteristic, "properties", []) or [])
                    }
                    supported.append((characteristic, characteristic_uuid, properties))
                    if characteristic_uuid == StandardGATTDeviceHandler.BATTERY_LEVEL:
                        battery_characteristic = characteristic

            if not supported:
                raise RuntimeError(
                    "No supported Bluetooth SIG health/battery characteristics were found"
                )

            for characteristic, characteristic_uuid, properties in supported:
                if properties.intersection({"notify", "indicate"}):
                    await client.start_notify(
                        characteristic,
                        lambda _ch, data, uuid_value=characteristic_uuid: (
                            self._on_standard_gatt_notification(mac, uuid_value, data)
                        ),
                    )
                    subscribed.append(characteristic)
                    print(f"[Standard GATT] {mac}: subscribed {characteristic_uuid}")
                elif "read" in properties:
                    raw = await client.read_gatt_char(characteristic)
                    self._on_standard_gatt_notification(mac, characteristic_uuid, raw)

            ready_event = state.get("monitor_ready_event")
            if ready_event:
                ready_event.set()
            self._set_monitor_phase(mac, "standard_gatt", DATA_RECEIVE_TIMEOUT)

            while client.is_connected and not self.shutdown_event.is_set():
                now = time.time()
                if (
                    battery_characteristic is not None
                    and now - state.get("last_battery_read", 0) >= BATTERY_READ_INTERVAL
                ):
                    state["last_battery_read"] = now
                    try:
                        raw = await client.read_gatt_char(battery_characteristic)
                        self._on_standard_gatt_notification(
                            mac, StandardGATTDeviceHandler.BATTERY_LEVEL, raw
                        )
                    except Exception as e:
                        print(f"[Standard GATT] {mac}: battery read failed: {e}")
                await asyncio.sleep(1)

        except Exception as e:
            state["monitor_setup_error"] = str(e)
            print(f"[Standard GATT] Monitoring error for {mac}: {e}")
        finally:
            ready_event = state.get("monitor_ready_event")
            if ready_event:
                ready_event.set()
            print(f"[Standard GATT] Monitoring ended for {mac}")

            lock_acquired = False
            try:
                device_lock = self._lock_for_device(mac)
                await asyncio.wait_for(
                    device_lock.acquire(), timeout=GATT_SETUP_TIMEOUT + 5.0
                )
                lock_acquired = True
            except asyncio.TimeoutError:
                print(f"    ⚠️ {mac}: adapter cleanup lock timed out")
            except Exception as e:
                print(f"    ⚠️ {mac}: adapter cleanup lock error: {type(e).__name__}: {e}")

            try:
                if client.is_connected:
                    for characteristic in subscribed:
                        try:
                            await client.stop_notify(characteristic)
                        except Exception:
                            pass
                    await asyncio.wait_for(client.disconnect(), timeout=5.0)
            except Exception as e:
                print(f"    ⚠️ Standard GATT safe disconnect error {mac}: {e}")
            finally:
                if lock_acquired:
                    device_lock.release()
                address = normalize_address(state.get("adapter_address", ""))
                if address in self.adapter_manager.adapters:
                    runtime = self.adapter_manager.adapters[address]
                    runtime.active_connections = max(0, runtime.active_connections - 1)
                await asyncio.sleep(1.5)
                state["connected"] = False
                state["task"] = None
                state["monitor_phase"] = "idle"
                state["phase_started_at"] = 0
                state["watchdog_deadline"] = 0

    def _on_standard_gatt_notification(
        self, mac: str, characteristic_uuid: str, data: bytes
    ):
        """Validate and publish one Bluetooth SIG characteristic payload."""
        extracted = StandardGATTDeviceHandler.parse_characteristic(
            characteristic_uuid, bytes(data)
        )
        if not extracted:
            return

        state = self.device_state.get(mac, {})
        state["last_data_timestamp"] = time.time()
        self._record_device_data_success(mac, extracted)
        metadata = self.device_registry.device_metadata.get(mac, {})
        self.vitals_publisher.publish_vitals(mac, extracted, metadata)

        values = ", ".join(
            f"{key.upper()}={value}"
            for key, value in extracted.items()
            if key in ("hr", "spo2", "temp", "batt")
        )
        if values and JSTYLE_VERBOSE_SENSOR_LOGS:
            print(f"  [Standard GATT] {mac}: {values}")

    async def _phase1_hr_temp(self, client: BleakClient, mac: str, metadata: dict) -> str:
        """Phase 1: Read HR and Temperature."""
        state = self.device_state[mac]
        if (
            state.get("is_wearing") == 0
            and state.get("stop_measurement_requested")
            and not state.get("wear_probe_active")
        ):
            return "off_wrist"
        state["stop_measurement_requested"] = False
        probe_mode = bool(state.get("wear_probe_active"))
        phase_timeout = JSTYLE_WEAR_PROBE_TIMEOUT if probe_mode else PHASE_1_DURATION
        self._set_monitor_phase(
            mac, "wear_probe" if probe_mode else "hr_temp", phase_timeout
        )
        phase_started = time.time()
        state["phase_hr_samples"] = []
        state["phase_temp_samples"] = []
        state["phase_hr_temp_packet_seen"] = False
        state["phase_first_hr_at"] = 0
        state["phase_first_temp_at"] = 0
        print(
            f"[BLE] {mac}: Phase 1 — HR/Temp stream started "
            f"(minimum={PHASE_1_MIN_DURATION}s, hard_timeout={phase_timeout:.0f}s, "
            f"probe={probe_mode})"
        )

        if JSTYLE_ENABLE_MEASURE_COMMANDS:
            try:
                await self._write_jstyle_command(client, mac, "HR/Temp start", 0x09, 0x01, 0x00, 0x00)
                print(f"[BLE] {mac}: HR/Temp command sent")
            except Exception as e:
                err_str = str(e).lower()
                if "not connected" in err_str or "unknownobject" in err_str or "not found" in err_str:
                    raise ConnectionError(f"Connection lost to {mac}: {e}")
                print(f"    ⚠️ {mac}: HR/Temp command error: {e}")

        phase_result = "timeout"
        # Stagger initial background reads so they don't fire immediately after start command
        now_ts = time.time()
        state["last_keepalive"] = now_ts - KEEPALIVE_INTERVAL + 3.0
        state["last_battery_read"] = now_ts - BATTERY_READ_INTERVAL + 5.0
        for _ in range(max(1, int(phase_timeout))):
            if not client.is_connected or self.shutdown_event.is_set():
                phase_result = "disconnected"
                break

            now = time.time()
            elapsed = now - phase_started
            if state.get("stop_measurement_requested") or (
                probe_mode and state.get("is_wearing") == 0
                and state.get("off_wrist_confirmation_count", 0) >= JSTYLE_OFF_WRIST_CONFIRMATIONS
            ):
                phase_result = "off_wrist"
                break
            if probe_mode and state.get("is_wearing") == 1:
                state["wear_probe_active"] = False
                probe_mode = False
                state["stop_measurement_requested"] = False
                phase_started = now
                self._set_monitor_phase(mac, "hr_temp", PHASE_1_DURATION)
                print(f"[BLE] {mac}: worn confirmed; continuing full HR/Temp measurement")
            if self._phase1_ready(state, elapsed):
                phase_result = "stable"
                first_hr_latency = max(0.0, float(state.get("phase_first_hr_at") or now) - phase_started)
                first_temp_latency = max(0.0, float(state.get("phase_first_temp_at") or now) - phase_started)
                print(
                    f"[BLE] {mac}: HR/Temp stable; ending phase early "
                    f"(elapsed={elapsed:.1f}s, first_hr={first_hr_latency:.1f}s, "
                    f"first_temp={first_temp_latency:.1f}s, samples={len(state['phase_hr_samples'])})"
                )
                break
            if (
                not probe_mode
                and elapsed >= JSTYLE_FIRST_SAMPLE_TIMEOUT
                and not state.get("phase_hr_temp_packet_seen")
                and not state.get("phase_hr_samples")
                and not state.get("phase_temp_samples")
            ):
                phase_result = "no_samples"
                print(
                    f"[BLE] {mac}: HR/Temp first-sample timeout "
                    f"(elapsed={elapsed:.1f}s)"
                )
                break

            # Keepalive
            last_ka = state.get("last_keepalive", 0)
            if (now - last_ka) >= KEEPALIVE_INTERVAL:
                state["last_keepalive"] = now
                try:
                    await self._write_jstyle_command(client, mac, "keepalive", 0x41)
                except Exception as e:
                    err_str = str(e).lower()
                    if "not connected" in err_str or "unknownobject" in err_str or "not found" in err_str:
                        raise ConnectionError(f"Connection lost to {mac}: {e}")

            # RSSI read
            last_rssi = state.get("last_rssi_read", 0)
            if (now - last_rssi) >= RSSI_READ_INTERVAL:
                state["last_rssi_read"] = now
                rssi = await self._read_connection_rssi(mac)
                if rssi is not None:
                    self.vitals_publisher.publish_rssi(mac, rssi)

            # Battery read
            last_batt = state.get("last_battery_read", 0)
            if (now - last_batt) >= BATTERY_READ_INTERVAL:
                state["last_battery_read"] = now
                try:
                    await self._write_jstyle_command(client, mac, "battery", 0x13, 0x00)
                except Exception as e:
                    err_str = str(e).lower()
                    if "not connected" in err_str or "unknownobject" in err_str or "not found" in err_str:
                        raise ConnectionError(f"Connection lost to {mac}: {e}")

            await asyncio.sleep(1)

        phase_elapsed = time.time() - phase_started
        if probe_mode and state.get("is_wearing") != 1:
            phase_result = "off_wrist"
            state["is_wearing"] = 0
            state["stop_measurement_requested"] = True
            state["off_wrist_probe_after"] = time.time() + JSTYLE_OFF_WRIST_PROBE_INTERVAL
        elif (
            phase_result == "timeout"
            and state.get("phase_hr_temp_packet_seen")
            and not state.get("phase_hr_samples")
            and not state.get("phase_temp_samples")
        ):
            phase_result = "sensor_no_reading"
        if client.is_connected and not self.shutdown_event.is_set() and not self._phase1_ready(state, phase_elapsed):
            if phase_result == "off_wrist":
                print(
                    f"[BLE] {mac}: HR/Temp stopped early for off-wrist "
                    f"(elapsed={phase_elapsed:.1f}s)"
                )
            elif phase_result == "sensor_no_reading":
                print(
                    f"[BLE] {mac}: HR/Temp sensor stayed at zero for the full "
                    f"{phase_elapsed:.1f}s phase"
                )
            elif phase_result != "no_samples":
                print(
                    f"[BLE] {mac}: HR/Temp hard timeout "
                    f"(hr_samples={len(state['phase_hr_samples'])}, "
                    f"temp_samples={len(state['phase_temp_samples'])})"
                )
        elif not client.is_connected:
            print(
                f"[BLE] {mac}: HR/Temp connection ended "
                f"(elapsed={phase_elapsed:.1f}s, hr_samples={len(state['phase_hr_samples'])}, "
                f"temp_samples={len(state['phase_temp_samples'])})"
            )
        return phase_result

    @staticmethod
    def _spo2_failure_is_retryable(state: dict) -> bool:
        return (
            state.get("is_wearing") == 1
            and state.get("last_failure_reason") in {
                "spo2_start_failed",
                "spo2_timeout",
                "spo2_no_progress",
                "spo2_unstable",
            }
        )

    async def _phase2_spo2_with_retries(
        self, client: BleakClient, mac: str
    ) -> bool:
        """Retry a silent optical stream while yielding the adapter fairly."""
        state = self.device_state[mac]
        metadata = (
            self.device_registry.device_metadata.get(mac, {})
            if self.device_registry is not None
            else {}
        )
        total_attempts = JSTYLE_SPO2_STREAM_RETRIES + 1

        for attempt in range(1, total_attempts + 1):
            await self._acquire_measurement_slot(mac)
            if not client.is_connected or self.shutdown_event.is_set():
                self._release_measurement_slot(mac)
                return False

            try:
                received = await self._phase2_spo2(client, mac)
            except BaseException:
                self._release_measurement_slot(mac)
                raise

            should_retry = (
                not received
                and attempt < total_attempts
                and client.is_connected
                and not self.shutdown_event.is_set()
                and self._spo2_failure_is_retryable(state)
            )
            
            # ESP32 parity: SpO2 Low Recheck
            # If we received a value but it's < 95%, retry it up to 3 times total
            # (only if we have retries left)
            SPO2_LOW_THRESHOLD = 95
            SPO2_LOW_RECHECK_MAX = 3
            spo2_val = int(state.get("last_spo2_value") or 0)
            should_retry_low = (
                received
                and spo2_val > 0
                and spo2_val < SPO2_LOW_THRESHOLD
                and attempt < min(total_attempts, SPO2_LOW_RECHECK_MAX)
                and client.is_connected
                and not self.shutdown_event.is_set()
            )
            
            if should_retry_low:
                print(f"[SPO2 LOW] {mac} {spo2_val}% < {SPO2_LOW_THRESHOLD}% → วัดซ้ำ ({attempt}/{SPO2_LOW_RECHECK_MAX})")
                should_retry = True

            # A recoverable first attempt and confirmed off-wrist state are not
            # completed sensor failures.
            record_result = not should_retry and state.get("is_wearing") != 0
            self._release_measurement_slot(mac, record_result=record_result)

            if not should_retry:
                return received

            state["spo2_retry_count"] = state.get("spo2_retry_count", 0) + 1
            state["spo2_quality"] = "retrying"
            state["last_result"] = "spo2_retry"
            self.vitals_publisher.publish_spo2_quality(
                mac,
                "retrying",
                metadata,
                attempt=attempt + 1,
                max_attempts=total_attempts,
            )
            print(
                f"[BLE] {mac}: restarting silent SpO2 stream in the same "
                f"connection ({attempt + 1}/{total_attempts})"
            )
            if JSTYLE_SPO2_RETRY_DELAY:
                await asyncio.sleep(JSTYLE_SPO2_RETRY_DELAY)

        return False

    async def _phase2_spo2(self, client: BleakClient, mac: str) -> bool:
        """Measure one device-owned SpO2 stream without blocking other devices."""
        state = self.device_state[mac]
        metadata = (
            self.device_registry.device_metadata.get(mac, {})
            if self.device_registry is not None else {}
        )

        if state.get("is_wearing") == 0:
            state["spo2_quality"] = "off_wrist"
            state["last_result"] = "off_wrist"
            state["last_failure_reason"] = "spo2_off_wrist"
            print(f"[BLE] {mac}: Skipping SpO2 phase because device is explicitly off-wrist")
            return False
        if not client.is_connected or self.shutdown_event.is_set():
            return False

        state["session_generation"] = state.get("session_generation", 0) + 1
        state["spo2_quality"] = "measuring"
        state["last_failure_reason"] = None
        state["spo2_off_wrist_seen"] = False
        state["spo2_off_wrist_confirmed"] = False
        state["spo2_ready"] = False
        state["last_spo2_value"] = 0
        state["spo2_candidate"] = 0
        state["spo2_candidate_count"] = 0
        state["spo2_samples"] = []
        state["spo2_warmup_remaining"] = SPO2_WARMUP_SAMPLES
        state["spo2_last_progress_at"] = 0
        state["spo2_progress_event"] = asyncio.Event()
        state["spo2_final_event"] = asyncio.Event()
        state["off_wrist_event"] = asyncio.Event()
        self.vitals_publisher.publish_spo2_quality(mac, "measuring", metadata)

        if JSTYLE_ENABLE_MEASURE_COMMANDS:
            await self._write_jstyle_command(client, mac, "HR/Temp stop", 0x09, 0x00, 0x00, 0x00)

        self._set_monitor_phase(mac, "spo2_settle", SPO2_SENSOR_SETTLE_SECONDS + PHASE_2_TIMEOUT)
        await asyncio.sleep(SPO2_SENSOR_SETTLE_SECONDS)
        if not client.is_connected or self.shutdown_event.is_set():
            return False

        self._set_monitor_phase(mac, "spo2", PHASE_2_TIMEOUT)
        print(f"[BLE] {mac}: independent SpO2 stream started (waiting for final result)")
        if JSTYLE_ENABLE_MEASURE_COMMANDS:
            try:
                await self._write_jstyle_command(client, mac, "SpO2 start", 0x28, 0x03, 0x01)
            except Exception as error:
                state["last_failure_reason"] = "spo2_start_failed"
                if "not connected" not in str(error).lower():
                    print(f"    ⚠️ {mac}: SpO2 start command error: {error}")
                return False

        stream_started_at = time.time()
        hard_deadline = stream_started_at + PHASE_2_TIMEOUT
        try:
            while client.is_connected and not self.shutdown_event.is_set():
                if state.get("spo2_ready") or state["spo2_final_event"].is_set():
                    print(f"[BLE] {mac}: final SpO2 result received")
                    break
                if state.get("spo2_off_wrist_confirmed") or state["off_wrist_event"].is_set():
                    print(f"[BLE] {mac}: confirmed off-wrist; ending SpO2 early")
                    break

                now = time.time()
                progress_reference = float(
                    state.get("spo2_last_progress_at") or stream_started_at
                )
                remaining = min(
                    hard_deadline - now,
                    SPO2_NO_PROGRESS_TIMEOUT - (now - progress_reference),
                )
                if remaining <= 0:
                    state["last_failure_reason"] = (
                        "spo2_timeout" if now >= hard_deadline
                        else "spo2_no_progress"
                    )
                    break
                waiters = [
                    asyncio.create_task(state["spo2_progress_event"].wait()),
                    asyncio.create_task(state["spo2_final_event"].wait()),
                    asyncio.create_task(state["off_wrist_event"].wait()),
                ]
                done = set()
                try:
                    done, _pending = await asyncio.wait(
                        waiters, timeout=remaining, return_when=asyncio.FIRST_COMPLETED
                    )
                finally:
                    for waiter in waiters:
                        if waiter not in done:
                            waiter.cancel()
                    await asyncio.gather(*waiters, return_exceptions=True)
                if state["spo2_progress_event"].is_set():
                    state["spo2_progress_event"].clear()
        finally:
            if JSTYLE_ENABLE_MEASURE_COMMANDS and client.is_connected:
                try:
                    await self._write_jstyle_command(client, mac, "SpO2 stop", 0x28, 0x03, 0x00)
                except Exception:
                    pass
            state["last_spo2_end_time"] = time.time()

        verified = int(state.get("last_spo2_value") or 0)
        final_samples = state.get("spo2_samples", [])
        # A final packet can arrive on the timeout boundary after the polling
        # loop's last ready check. Presence in spo2_samples is authoritative:
        # only a checksum-valid, worn, byte-3 final result is added there.
        if verified and (state.get("spo2_ready") or final_samples):
            state["spo2_ready"] = True
            state["spo2_quality"] = "verified"
            self.vitals_publisher.publish_vitals(mac, {
                "spo2": verified,
                "spo2_quality": "verified",
                "status": 1,
                "provider": JStyleDeviceHandler.PROVIDER,
            }, metadata)
            self.vitals_publisher.publish_spo2_quality(
                mac, "verified", metadata,
                value=verified, samples=state.get("spo2_candidate_count", 0),
            )
            level = "LOW" if verified < SPO2_LOW_THRESHOLD else "OK"
            state["last_spo2_verified_at"] = time.time()
            self._record_device_data_success(mac, {
                "spo2": verified,
                "status": 1,
                "provider": JStyleDeviceHandler.PROVIDER,
            })
            state["last_result"] = "spo2_verified"
            state["last_failure_reason"] = None
            print(f"[BLE] {mac}: SpO2 verified={verified}% ({level}, single stream)")
            return True

        samples_seen = len(state.get("spo2_samples", []))
        quality = "unstable" if samples_seen else (
            "off_wrist" if state.get("spo2_off_wrist_seen") else "timeout"
        )
        state["spo2_quality"] = quality
        state["last_spo2_value"] = 0
        state["last_result"] = quality
        state["last_failure_reason"] = state.get("last_failure_reason") or f"spo2_{quality}"
        self.vitals_publisher.publish_spo2_quality(
            mac, quality, metadata,
            samples=samples_seen,
        )
        print(f"[BLE] {mac}: SpO2 {quality} after one stream ({samples_seen} samples)")
        return False

    async def _read_connection_rssi(self, mac: str) -> Optional[int]:
        """Read RSSI of active connection via hcitool."""
        try:
            proc = await asyncio.create_subprocess_shell(
                f"hcitool rssi {mac}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=3.0)
            output = stdout.decode().strip()
            match = re.search(r"(-?\d+)", output)
            if match:
                return int(match.group(1))
        except Exception as e:
            print(f"[BLE] RSSI read error for {mac}: {e}")
        return None

    # ----------------------------------------------------------
    # RECOVERY
    # ----------------------------------------------------------

    async def _recover_from_inprogress(self):
        """Recover from BlueZ InProgress state — graceful shutdown."""
        self.recovery_attempt += 1
        print(f"[BLE] Recovery attempt #{self.recovery_attempt}")

        if self.recovery_attempt == 1:
            print("[BLE] Recovery L1: DBus StopDiscovery + Restart scanner")
            for runtime in self.adapter_manager.adapters.values():
                await self._run_shell(
                    f"busctl call org.bluez /org/bluez/{runtime.interface} "
                    "org.bluez.Adapter1 StopDiscovery"
                )
            if not self.adapter_manager.adapters:
                await self._run_shell("busctl call org.bluez /org/bluez/hci0 org.bluez.Adapter1 StopDiscovery")
            await self.stop_scanner()
            await asyncio.sleep(2.0)
            await self.start_scanner()
            await asyncio.sleep(2.0)
            return

        if self.recovery_attempt == 2:
            print("[BLE] Recovery L2: Graceful restart (hciconfig unavailable in Docker)")
            # In Docker, we lack CAP_NET_ADMIN for hciconfig. Skip to L3 fast fail.
            pass

        # L3: Graceful shutdown — cleanup MQTT + BlueZ state, then exit cleanly
        print("[BLE] Recovery L3: Graceful shutdown")
        if self.mqtt_manager:
            self.mqtt_manager.stop()
        if self.scanner:
            await asyncio.wait_for(self.scanner.stop(), timeout=5.0)
        print("[BLE] Recovery complete — process exiting cleanly")
        sys.exit(1)

    @staticmethod
    async def _run_shell(cmd: str, timeout: float = 10.0) -> bool:
        proc = None
        try:
            proc = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=timeout)
            return proc.returncode == 0
        except asyncio.CancelledError:
            if proc is not None and proc.returncode is None:
                try:
                    proc.kill()
                    await proc.wait()
                except (ProcessLookupError, AttributeError):
                    pass
            raise
        except asyncio.TimeoutError:
            if proc is not None and proc.returncode is None:
                try:
                    proc.kill()
                    await proc.wait()
                except (ProcessLookupError, AttributeError):
                    pass
            print(f"[BLE] Shell timeout after {timeout:.1f}s for '{cmd}'")
            return False
        except Exception as e:
            print(f"[BLE] Shell error for '{cmd}': {e}")
            return False

    def _cleanup_before_exit(self):
        """Cleanup all resources."""
        print("[BLE] Cleanup: stopping MQTT...")
        if self.mqtt_manager:
            self.mqtt_manager.stop()
        print("[BLE] Cleanup: stopping scanner...")
        if self.scanner:
            try:
                asyncio.get_event_loop().run_until_complete(self.scanner.stop())
            except Exception:
                pass

    # ----------------------------------------------------------
    # SYSTEM & ADAPTER TOOLS (from iStyle24.py)
    # ----------------------------------------------------------

    async def _get_discovery_status(self, force: bool = False) -> Optional[bool]:
        """Read BlueZ discovery as true/false/unknown with rate limiting.

        D-Bus can temporarily reject property reads while GATT traffic is active.
        Unknown must not be confused with a confirmed stopped scanner, otherwise
        each controller loop creates a stop/start storm that further overloads BlueZ.
        """
        now = time.monotonic()
        if not force and now - self.discovery_status_checked_at < 5.0:
            return self.discovery_status_cache
        if not force and now < self.discovery_status_retry_at:
            return self.discovery_status_cache
        try:
            proc = await asyncio.create_subprocess_shell(
                "busctl get-property org.bluez /org/bluez/hci0 org.bluez.Adapter1 Discovering",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=3.0)
            if proc.returncode != 0:
                raise RuntimeError(stderr.decode(errors="ignore").strip() or "busctl failed")
            status = stdout.decode().strip().lower() in {"b true", "true"}
            self.discovery_status_cache = status
            self.discovery_status_checked_at = now
            self.discovery_status_retry_at = 0.0
            return status
        except Exception as e:
            self.discovery_status_checked_at = now
            self.discovery_status_retry_at = now + 15.0
            if now - self.discovery_status_last_error_log >= 30.0:
                print(f"    ⚠️ Discovery status temporarily unavailable: {e}")
                self.discovery_status_last_error_log = now
            return None

    async def _verify_adapter_healthy(self) -> bool:
        """Verify adapter works by doing a quick test scan."""
        try:
            await asyncio.wait_for(
                BleakScanner.discover(timeout=3.0, return_adv=True),
                timeout=8.0,
            )
            return True
        except Exception as e:
            print(f"    ⚠️ [VERIFY] Test scan failed: {e}")
            return False

    async def _hard_reset_adapter(self) -> bool:
        """
        Auto-recovery with 2-level escalation:
          L1: hciconfig down/up (hardware reset)
          L2: systemctl restart bluetooth (BlueZ daemon reset)
        Each level verified by actual scan, not just flag check.
        """
        print("    🔧 [LEVEL 1] hciconfig down/up...")
        await self._run_shell("hciconfig hci0 down", timeout=5.0)
        await asyncio.sleep(2.0)
        await self._run_shell("hciconfig hci0 up", timeout=5.0)
        await asyncio.sleep(3.0)

        if await self._verify_adapter_healthy():
            print("    ✅ [AUTO-RECOVERY] LEVEL 1 success")
            return True

        print("    🔧 [LEVEL 2] systemctl restart bluetooth...")
        ok = await self._run_shell("systemctl restart bluetooth", timeout=20.0)
        if not ok:
            print("    ⚠️ [LEVEL 2] restart returned error")
        print("    ⏳ Waiting for bluetoothd to reinitialize...")
        await asyncio.sleep(8.0)
        await self._run_shell("hciconfig hci0 up", timeout=5.0)
        await asyncio.sleep(3.0)

        if await self._verify_adapter_healthy():
            print("    ✅ [AUTO-RECOVERY] LEVEL 2 success")
            return True

        print("    🆘 [AUTO-RECOVERY] Both levels failed — hardware check needed")
        return False

    async def _startup_adapter_cleanup(self):
        """Clean stale Bluetooth state at startup (prevents first-run InProgress)."""
        print("🧹 [STARTUP] Cleaning stale Bluetooth state...")
        try:
            # A recreated container cannot see monitor tasks from its predecessor,
            # while BlueZ may retain those ACL links for several minutes. This is
            # a dedicated central adapter, so release stale links before applying
            # the new connection budget. `bluetoothctl devices Connected` only
            # inspects its default controller, so enumerate BlueZ object paths
            # for every configured adapter instead.
            interfaces = [
                item.interface for item in self.adapter_manager.adapters.values()
            ] or ["hci0"]
            cleanup_results = await asyncio.gather(*(
                self._run_shell(
                    "busctl tree org.bluez | "
                    f"grep -o '/org/bluez/{interface}/dev_[0-9A-Fa-f_]*' | "
                    "sort -u | while IFS= read -r path; do "
                    "connected=$(busctl --timeout=2 get-property org.bluez \"$path\" "
                    "org.bluez.Device1 Connected 2>/dev/null || true); "
                    "if [ \"$connected\" = \"b true\" ]; then "
                    "busctl --timeout=2 call org.bluez \"$path\" "
                    "org.bluez.Device1 Disconnect >/dev/null 2>&1 || true; "
                    "fi; done",
                    timeout=12.0,
                )
                for interface in interfaces
            ))
            if not all(cleanup_results):
                print("    ⚠️ Some stale-link cleanup commands timed out or failed")
            await asyncio.sleep(1.0)
            for interface in interfaces:
                await self._run_shell(
                    f"busctl call org.bluez /org/bluez/{interface} "
                    "org.bluez.Adapter1 StopDiscovery",
                    timeout=5.0,
                )
            deadline = time.monotonic() + 5.0
            discovering = await self._get_discovery_status(force=True)
            while discovering is True and time.monotonic() < deadline:
                await asyncio.sleep(0.5)
                discovering = await self._get_discovery_status(force=True)

            if discovering is True:
                # Another BlueZ client can transiently retain discovery ownership.
                # Do not reset the shared host adapter during container startup;
                # start_scanner() reconciles ownership and the data-plane watchdog
                # still escalates if advertisements remain stale.
                print("    ⚠️ Discovery still active; deferring recovery to scanner watchdog")
            else:
                detail = "status unavailable; scanner will verify data-plane" if discovering is None else "ready to use"
                print(f"    ✅ Adapter clean, {detail}")
        except Exception as e:
            print(f"    ⚠️ [STARTUP] Cleanup error: {e}")

    # ----------------------------------------------------------
    # WATCHDOG
    # ----------------------------------------------------------

    async def _recover_dual_adapter_scanners(self, now: float) -> None:
        """Recover both missing scanner objects and silent active scanners."""
        for address, runtime in self.adapter_manager.adapters.items():
            try:
                if (
                    not runtime.powered
                    or runtime.active_connections
                    >= self.adapter_manager.max_connections_per_adapter
                    or self._adapter_connect_attempt_active(address, now)
                ):
                    continue

                if address not in self.scanners:
                    # A connect path removes its scanner before touching BlueZ.
                    # If that path crashes or used to hang, no scanner object is
                    # left for the old stale-scanner branch to recover.
                    if runtime.recovery_until > now:
                        continue
                    print(
                        f"[WATCHDOG] Scanner missing on {runtime.interface}; "
                        "restoring discovery"
                    )
                    if not await self._start_adapter_scanner(address):
                        runtime.healthy = False
                        runtime.recovery_until = now + 60
                    continue

                last_adv = self.last_advertisement_by_adapter.get(address, 0.0)
                scanner_started = self.scanner_started_at_by_adapter.get(address, now)
                recovery_until = self.scanner_recovery_until_by_adapter.get(address, 0)
                silence_limit = self._adapter_scanner_silence_limit(address, now)
                silence_seconds = now - max(last_adv, scanner_started)
                control_plane_stopped = False
                if (
                    runtime.active_connections == 0
                    and now >= recovery_until
                    and silence_seconds > BLE_SCANNER_STALE_SECONDS
                ):
                    control_plane_stopped = (
                        await self._adapter_discovering(address)
                    ) is False
                stale = (
                    runtime.active_connections == 0
                    and now >= recovery_until
                    and (
                        control_plane_stopped
                        or silence_seconds > silence_limit
                    )
                )
                if not stale:
                    continue
                reason = (
                    "BlueZ discovery stopped"
                    if control_plane_stopped
                    else f"no advertisements for {silence_seconds:.0f}s"
                )
                print(
                    f"[WATCHDOG] Scanner stale on {runtime.interface} "
                    f"({reason}); "
                    "restarting only this adapter"
                )
                self.scanner_recovery_until_by_adapter[address] = (
                    now + BLE_SCANNER_RECOVERY_COOLDOWN_SECONDS
                )
                await self._stop_adapter_scanner(address, force_bluez=True)
                await asyncio.sleep(1.0)
                if not await self._start_adapter_scanner(address):
                    runtime.healthy = False
                    runtime.recovery_until = now + 60
            except asyncio.CancelledError:
                raise
            except Exception as error:
                runtime.healthy = False
                runtime.recovery_until = now + 60
                print(
                    f"[WATCHDOG] Recovery error on {runtime.interface}: {error}"
                )

    async def _watchdog_cycle(self) -> None:
        """Run one connection and scanner recovery cycle."""
        now = time.time()

        for mac, state in self.device_state.items():
            if state.get("connected") and state.get("task") and not state["task"].done():
                device_type = self.device_registry.device_metadata.get(mac, {}).get("device_type", "jstyle")
                if self._connection_is_stale(state, device_type, now):
                    phase = state.get("monitor_phase", "unknown")
                    last = max(
                        float(state.get("last_data_timestamp") or 0),
                        float(state.get("connected_time") or 0),
                    )
                    age = max(0, int(now - last)) if last else 0
                    print(
                        f"[WATCHDOG] Stale connection for {mac} "
                        f"(phase={phase}, age={age}s), cancelling task"
                    )
                    state["task"].cancel()

        advertisement_age = max(0.0, now - self.last_advertisement_timestamp)
        discovering = await self._get_discovery_status()

        if self.dual_adapter_enabled:
            await self._recover_dual_adapter_scanners(now)
        elif self._scanner_data_plane_stale(now):
            self.scanner_stale_recovery_count += 1
            print(
                "[WATCHDOG] Scanner data plane stale "
                f"(advertisement_age={advertisement_age:.0f}s, "
                f"object={self.scanner is not None}, discovering={discovering}, "
                f"recovery={self.scanner_stale_recovery_count}); restarting"
            )
            await self.stop_scanner()
            await asyncio.sleep(1.0)
            if self.scanner_stale_recovery_count >= 2:
                print("[WATCHDOG] Scanner still silent; escalating to HCI adapter reset")
                await self._run_shell("hciconfig hci0 down", timeout=5.0)
                await asyncio.sleep(2.0)
                await self._run_shell("hciconfig hci0 up", timeout=5.0)
                await asyncio.sleep(3.0)
            if not await self.start_scanner():
                await self._recover_from_inprogress()
            discovering = await self._get_discovery_status()

        self.controller_heartbeat = time.time()
        self._write_health_state(discovering)

    async def _connection_watchdog(self):
        """Monitor connections without dying on a transient recovery error."""
        await self.startup_cleanup_complete.wait()
        while not self.shutdown_event.is_set():
            try:
                await asyncio.sleep(WATCHDOG_INTERVAL)
                await self._watchdog_cycle()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self.controller_heartbeat = time.time()
                print(f"[WATCHDOG] Cycle error; will retry: {error}")
                self._write_health_state()

    # ----------------------------------------------------------
    # MAIN CONTROLLER
    # ----------------------------------------------------------

    async def main_controller(self):
        """Main BLE controller loop."""
        print("[BLE] Starting main controller...")

        # Keep the watchdog gated through both stale-state cleanup and initial
        # scanner creation. Otherwise its first recovery cycle can race the
        # in-flight StartDiscovery calls and make every adapter time out.
        try:
            await self._startup_adapter_cleanup()
            if not await self.start_scanner():
                print("[BLE] Scanner failed to start — entering recovery")
                await self._recover_from_inprogress()
        finally:
            self.startup_cleanup_complete.set()

        while not self.shutdown_event.is_set():
            try:
                # Check for stale discovered devices
                now = time.time()
                self.controller_heartbeat = now
                found_targets = []

                for mac, info in list(self.discovered.items()):
                    age = now - info["seen"]
                    if age > BLE_STALE_THRESHOLD:
                        continue
                    rssi = info.get("rssi")
                    if rssi is not None and rssi < BLE_RSSI_MIN_THRESHOLD:
                        continue
                    found_targets.append(mac)

                # Clean stale entries
                for mac in list(self.discovered.keys()):
                    if mac not in found_targets:
                        del self.discovered[mac]

                found_targets = self._prioritize_connection_targets(found_targets)

                if found_targets:
                    printable = []
                    for target in found_targets:
                        info = self.discovered.get(target, {})
                        meta = self.device_registry.device_metadata.get(target, {})
                        if meta.get("device_type") == "wearos":
                            printable.append(f"{target}(WearOS BLE={info.get('ble_address')} name={info.get('local_name')})")
                        else:
                            printable.append(target)
                    print(f"[BLE] Devices in range: {printable}")

                # --- B1: Parallel GATT connect across adapters ---
                # Collect eligible targets first, then group by adapter and
                # launch one connection per adapter simultaneously.
                eligible = []
                for mac in found_targets:
                    if self.shutdown_event.is_set():
                        break
                    meta = self.device_registry.device_metadata.get(mac, {})
                    device_type = meta.get("device_type", "jstyle")
                    driver = DRIVER_REGISTRY.get(device_type)
                    state = self.device_state.get(mac)
                    if not state:
                        continue

                    # Skip if already connected or monitoring
                    if state.get("connected"):
                        continue
                    if state.get("task") and not state["task"].done():
                        continue

                    # Check cooldown
                    if time.time() < state.get("cooldown_until", 0):
                        continue
                    if (
                        driver.mode == DRIVER_MODE_JSTYLE
                        and self._defer_off_wrist_device(state)
                    ):
                        continue

                    if driver.mode in {
                        DRIVER_MODE_ADVERTISEMENT,
                        DRIVER_MODE_EXTERNAL,
                        DRIVER_MODE_UNSUPPORTED,
                    }:
                        continue

                    if driver.mode == DRIVER_MODE_JSTYLE and not JSTYLE_CONNECT_FOR_GATT:
                        continue

                    if not self._can_start_gatt_connection(mac):
                        continue

                    info = self.discovered.get(mac)
                    if not info:
                        continue

                    eligible.append((mac, info["device"]))

                if eligible and self.dual_adapter_enabled:
                    # Group eligible targets by their last-seen adapter.
                    # Launch one connect_and_monitor per adapter group in
                    # parallel — connections on the *same* adapter stay
                    # sequential because BlueZ cannot multiplex GATT setup.
                    adapter_groups: dict[str, list[tuple[str, object]]] = {}
                    for mac, ble_device in eligible:
                        disc = self.discovered.get(mac, {})
                        addr = normalize_address(disc.get("adapter_address", "")) or "DEFAULT"
                        adapter_groups.setdefault(addr, []).append((mac, ble_device))

                    async def _connect_adapter_group(targets_for_adapter):
                        for mac, ble_device in targets_for_adapter:
                            if self.shutdown_event.is_set():
                                break
                            if not self._can_start_gatt_connection(mac):
                                break
                            await self.connect_and_monitor(mac, ble_device)

                    tasks = [
                        asyncio.create_task(_connect_adapter_group(group))
                        for group in adapter_groups.values()
                    ]
                    if tasks:
                        await asyncio.gather(*tasks, return_exceptions=True)

                elif eligible:
                    # Single-adapter fallback: sequential connect as before.
                    for mac, ble_device in eligible:
                        if self.shutdown_event.is_set():
                            break
                        if not self._can_start_gatt_connection(mac):
                            break
                        await self.connect_and_monitor(mac, ble_device)

                # Restart scanners after parallel connections are set up.
                if (
                    not self.shutdown_event.is_set()
                    and self._connection_budget_has_capacity()
                    and self._scanner_capacity_missing()
                ):
                    await self.start_scanner()

                # Scanner ownership stays in the controller so monitor tasks
                # cannot restart discovery during another device's GATT setup.
                if (
                    not self.shutdown_event.is_set()
                    and self._connection_budget_has_capacity()
                    and self._scanner_capacity_missing()
                ):
                    await self.start_scanner()

                if (
                    not self.dual_adapter_enabled
                    and self.scanner
                    and not self._connection_budget_has_capacity()
                ):
                    print("[BLE] Connection budget full; pausing discovery until a slot is released")
                    await self.stop_scanner()

                self._write_health_state(await self._get_discovery_status())
                await asyncio.sleep(BLE_CACHE_CHECK_INTERVAL)

            except Exception as e:
                print(f"[MAIN LOOP ERROR] {e}")
                await asyncio.sleep(5)

    # ----------------------------------------------------------
    # LIFECYCLE
    # ----------------------------------------------------------

    async def start(self):
        """Start the gateway."""
        await self.initialize()

        # Start device sync task
        sync_task = asyncio.create_task(self.sync_devices(), name="device-registry-sync")

        # Start main controller
        controller_task = asyncio.create_task(self.main_controller(), name="ble-main-controller")

        # Start watchdog
        watchdog_task = asyncio.create_task(self._connection_watchdog(), name="ble-watchdog")
        operational_log_task = asyncio.create_task(
            self._operational_log_loop(), name="operational-log"
        )
        self.background_tasks = [
            sync_task, controller_task, watchdog_task, operational_log_task
        ]

        # Handle signals
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, lambda: asyncio.create_task(self.shutdown()))

        await asyncio.gather(*self.background_tasks, return_exceptions=True)
        if self.shutdown_started and not self.shutdown_complete.is_set():
            await self.shutdown_complete.wait()

    async def shutdown(self):
        """Full graceful shutdown — stop all tasks cleanly."""
        if self.shutdown_started:
            await self.shutdown_complete.wait()
            return

        self.shutdown_started = True
        print("[SHUTDOWN] Full shutdown...")
        self.shutdown_event.set()

        tasks_to_cancel = list(self.background_tasks)
        for state in self.device_state.values():
            monitor_task = state.get("task")
            if monitor_task:
                tasks_to_cancel.append(monitor_task)

        tasks_to_cancel = list(dict.fromkeys(tasks_to_cancel))
        for task in tasks_to_cancel:
            if not task.done():
                task.cancel()
        if tasks_to_cancel:
            await asyncio.gather(*tasks_to_cancel, return_exceptions=True)

        print("[SHUTDOWN] Stopping scanner...")
        try:
            await self.stop_scanner()
        except Exception as e:
            print(f"    ⚠️ Scanner stop error: {e}")

        print("[SHUTDOWN] Stopping MQTT...")
        if self.mqtt_manager:
            try:
                self.mqtt_manager.stop()
            except Exception as e:
                pass

        print("[SHUTDOWN] Done — process exiting cleanly")
        self.shutdown_complete.set()

    def run(self):
        """Run the gateway (blocking)."""
        try:
            asyncio.run(self.start())
        except KeyboardInterrupt:
            print("[SHUTDOWN] Keyboard interrupt")


# ============================================================
# ENTRY POINT
# ============================================================

if __name__ == "__main__":
    gateway = NurseAidBLEGateway()
    gateway.run()
