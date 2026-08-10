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
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any

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
BLE_REQUIRE_PAIRED = _env_bool("BLE_REQUIRE_PAIRED", True)
BLE_DEVICE_SYNC_INTERVAL = _env_int("BLE_DEVICE_SYNC_INTERVAL", 30)
BLE_CONNECT_TIMEOUT = _env_float("BLE_CONNECT_TIMEOUT", 20.0)
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
BLE_HEALTH_FILE = Path(_env_str("BLE_HEALTH_FILE", "/tmp/nurseaid-ble-health.json"))
BLE_OPERATIONAL_LOG_INTERVAL = max(30, _env_int("BLE_OPERATIONAL_LOG_INTERVAL", 60))
BLE_MAX_GATT_CONNECTIONS = max(1, _env_int("BLE_MAX_GATT_CONNECTIONS", 2))
BLE_RESERVED_WEAROS_SLOTS = min(
    BLE_MAX_GATT_CONNECTIONS,
    max(0, _env_int("BLE_RESERVED_WEAROS_SLOTS", 1)),
)

# --- Protocol Timing ---
PHASE_1_DURATION = max(15, _env_int("PHASE_1_DURATION", 35))
PHASE_1_MIN_DURATION = max(5, min(PHASE_1_DURATION, _env_int("PHASE_1_MIN_DURATION", 15)))
PHASE_1_STABLE_SAMPLES = max(2, _env_int("PHASE_1_STABLE_SAMPLES", 3))
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
JSTYLE_OFF_WRIST_CONFIRMATIONS = max(1, _env_int("JSTYLE_OFF_WRIST_CONFIRMATIONS", 3))
JSTYLE_CYCLES_PER_CONNECTION = max(1, _env_int("JSTYLE_CYCLES_PER_CONNECTION", 1))
JSTYLE_ROTATION_COOLDOWN = max(0.0, _env_float("JSTYLE_ROTATION_COOLDOWN", 5.0))

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


# ============================================================
# MQTT CLIENT
# ============================================================

class MQTTManager:
    """Manages MQTT connection and publishing."""

    def __init__(self, host: str, port: int, user: str, password: str):
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.client = None
        self._connect()

    def _connect(self):
        # Compatible with both paho-mqtt 1.x and 2.x
        try:
            self.client = mqtt.Client(
                mqtt.CallbackAPIVersion.VERSION1,
                client_id=f"nurseaid_gateway_{int(time.time())}"
            )
        except AttributeError:
            # paho-mqtt 1.x — no CallbackAPIVersion
            self.client = mqtt.Client(client_id=f"nurseaid_gateway_{int(time.time())}")

        if self.user and self.password:
            self.client.username_pw_set(self.user, self.password)

        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
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

    def _on_connect(self, client, userdata, flags, rc):
        if rc == 0:
            print("[MQTT] Connected successfully")
        else:
            print(f"[MQTT] Connected but broker returned error code {rc}")

    def _on_disconnect(self, client, userdata, rc):
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

            # Build query based on BLE_REQUIRE_PAIRED
            where_clauses = ["mac IS NOT NULL", "mac <> ''"]
            if self.require_paired:
                where_clauses.append("hm_number IS NOT NULL")

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


# ============================================================
# WearOS Device Handler (NurseAid GATT Peripheral)
# ============================================================

class WearOSDeviceHandler:
    """Handles NurseAid Wear OS BLE GATT notifications containing UTF-8 JSON."""

    @staticmethod
    def parse_vitals(mac: str, data: bytes):
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
        if status is None and provider != JStyleDeviceHandler.PROVIDER:
            status = 1 if (hr or spo2 or temp or batt) else 0

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
            "provider": provider,
            "source": "raspberrypi5_ble_gateway",
            "transport": "ble",
            "bridge": "raspberrypi5",
            "interval_sec": 60,
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
            if now - self.last_published[mac].get(topic, 0) >= self.publish_interval:
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
                    }
                    if topic == TOPIC_SPO2:
                        payload["quality"] = spo2_quality or ("verified" if provider != JStyleDeviceHandler.PROVIDER else "unavailable")
                    self.mqtt.publish_json(topic, payload)
                    self.last_published[mac][topic] = now

    def publish_sensor_metrics(self, mac: str, extracted: dict, device_metadata: dict):
        """Publish non-clinical, protocol-neutral sensor metrics safely."""
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
        self.background_tasks = []
        self.mqtt_manager: Optional[MQTTManager] = None
        self.device_registry: Optional[DeviceRegistry] = None
        self.vitals_publisher: Optional[VitalsPublisher] = None

        # BLE state
        self.scanner: Optional[BleakScanner] = None
        self.scanner_started_at = 0.0
        self.last_advertisement_timestamp = time.time()
        self.controller_heartbeat = time.time()
        self.discovery_status_cache: Optional[bool] = None
        self.discovery_status_checked_at = 0.0
        self.discovery_status_retry_at = 0.0
        self.discovery_status_last_error_log = 0.0
        self.scanner_control_lock = asyncio.Lock()
        self.discovered: Dict[str, dict] = {}  # mac -> {device, rssi, seen}
        self.device_state: Dict[str, dict] = {}  # mac -> runtime state
        self.ble_adapter_lock = asyncio.Lock()
        # JStyle devices share one physical adapter. Serialize the complete
        # HR/Temp -> SpO2 transition so devices waiting their turn can keep
        # streaming HR/Temp instead of going silent for several minutes.
        self.jstyle_measurement_lock = asyncio.Lock()

        # Error handling
        self.inprogress_error_counter = 0
        self.recovery_attempt = 0
        self.scanner_stale_recovery_count = 0
        self.last_unmatched_wearos_log = 0

    def _active_connection_count(self) -> int:
        return sum(1 for state in self.device_state.values() if state.get("connected"))

    def _connection_budget_has_capacity(self) -> bool:
        return self._active_connection_count() < BLE_MAX_GATT_CONNECTIONS

    def _active_connection_count_for_mode(self, mode: str) -> int:
        metadata = getattr(self.device_registry, "device_metadata", {}) or {}
        return sum(
            1
            for mac, state in self.device_state.items()
            if state.get("connected")
            and DRIVER_REGISTRY.get(metadata.get(mac, {}).get("device_type", "jstyle")).mode == mode
        )

    def _can_start_gatt_connection(self, mac: str) -> bool:
        """Enforce the adapter budget and preserve capacity for a Wear OS link."""
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
        return {
            "event": "operational_status",
            "registeredDevices": len(getattr(registry, "registered_macs", set()) or set()),
            "connectedDevices": self._active_connection_count(),
            "discoveredDevices": len(self.discovered),
            "scannerActive": self.scanner is not None,
            "criticalMeasurement": self.jstyle_measurement_lock.locked(),
            "connectionBudget": BLE_MAX_GATT_CONNECTIONS,
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
            and not self.jstyle_measurement_lock.locked()
            and now - self.last_advertisement_timestamp > BLE_SCANNER_STALE_SECONDS
        )

    def _write_health_state(self, discovering: Optional[bool] = None):
        """Expose controller/data-plane liveness to the container healthcheck."""
        now = time.time()
        active_connections = self._active_connection_count()
        critical = self.jstyle_measurement_lock.locked()
        advertisement_age = max(0.0, now - self.last_advertisement_timestamp)
        scanner_healthy = (
            active_connections > 0
            or critical
            or (bool(discovering) and advertisement_age <= BLE_SCANNER_STALE_SECONDS)
        )
        payload = {
            "timestamp": now,
            "controllerHeartbeat": self.controller_heartbeat,
            "discovering": discovering,
            "activeConnections": active_connections,
            "criticalMeasurement": critical,
            "lastAdvertisementAgeSeconds": round(advertisement_age, 1),
            "scannerHealthy": scanner_healthy,
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
        print(f"  GATT TX/RX:     {CHAR_TX} / {CHAR_RX}")
        print(f"  WearOS Service: {WEAROS_SERVICE_UUID}")
        print(f"  WearOS Vitals:  {WEAROS_VITALS_UUID}")
        print(f"  JStyle Commands: {JSTYLE_ENABLE_MEASURE_COMMANDS}")
        print(f"  JStyle Adv Publish: {JSTYLE_PUBLISH_ADVERTISEMENT}")
        print(f"  JStyle GATT Connect: {JSTYLE_CONNECT_FOR_GATT}")
        print(f"  GATT Connection Budget: {BLE_MAX_GATT_CONNECTIONS} (WearOS reserved: {BLE_RESERVED_WEAROS_SLOTS})")
        print(f"  JStyle Rotation: {JSTYLE_CYCLES_PER_CONNECTION} cycle(s) per connection")
        print(f"  Sensor Drivers: {', '.join(DRIVER_REGISTRY.supported_types())}")
        print("=" * 60)

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
                "last_spo2_value": 0,
                "spo2_timeout_count": 0,
                "last_battery_read": 0,
                "last_keepalive": 0,
                "last_rssi_read": 0,
                "hr_zero_start": None,
                # Unknown until enough protocol packets explicitly confirm worn/off-wrist.
                "is_wearing": None,
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
                "phase_hr_samples": [],
                "phase_temp_samples": [],
                "phase_first_hr_at": 0,
                "phase_first_temp_at": 0,
                "spo2_last_progress_at": 0,
                "spo2_off_wrist_confirmed": False,
                "cycle_started_at": 0,
            }

    def _set_monitor_phase(self, mac: str, phase: str, expected_seconds: float):
        """Record the active protocol phase and its watchdog deadline."""
        state = self.device_state[mac]
        now = time.time()
        state["monitor_phase"] = phase
        state["phase_started_at"] = now
        state["watchdog_deadline"] = now + max(float(expected_seconds), 1.0) + JSTYLE_PHASE_WATCHDOG_GRACE

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

    def _spo2_queue_timeout(self) -> float:
        """Worst-case fair queue wait when all registered JStyle devices request SpO2."""
        metadata = getattr(self.device_registry, "device_metadata", {}) or {}
        jstyle_count = sum(
            1 for meta in metadata.values()
            if meta.get("device_type", "jstyle") == "jstyle"
        )
        return max(1, jstyle_count) * (PHASE_2_TIMEOUT + SPO2_SENSOR_SETTLE_SECONDS + 2)

    @staticmethod
    def _retry_backoff(fail_count: int) -> float:
        """Bound retry delay so weak devices cannot monopolize the adapter."""
        return min(
            BLE_RETRY_BACKOFF_MAX,
            BLE_RETRY_BACKOFF_BASE * (2 ** max(0, fail_count - 1)),
        )

    def _prioritize_connection_targets(self, targets):
        """Prioritize driver classes, then fairly rotate connection attempts."""
        return sorted(
            targets,
            key=lambda mac: (
                self._driver_for(mac).priority,
                float(self.device_state.get(mac, {}).get("last_connection_attempt") or 0),
                mac,
            ),
        )

    # ----------------------------------------------------------
    # DEVICE REGISTRY SYNC
    # ----------------------------------------------------------

    async def sync_devices(self):
        """Periodically sync device list from database."""
        while not self.shutdown_event.is_set():
            try:
                count, new_count, removed_count = await self.device_registry.sync_from_db()

                if new_count > 0:
                    print(f"[DB] Discovered {new_count} new device(s) from DB")
                if removed_count > 0:
                    print(f"[DB] Removed {removed_count} device(s) from DB")

                # Initialize state for new devices
                for mac in self.device_registry.registered_macs:
                    if mac not in self.device_state:
                        self._init_device_state(mac)

                # Clean up state for removed devices
                for mac in list(self.device_state.keys()):
                    if mac not in self.device_registry.registered_macs:
                        if self.device_state[mac].get("connected"):
                            print(f"[DB] Device {mac} removed from DB but still connected — will disconnect")
                        del self.device_state[mac]

                print(f"[DB] Active devices: {count}")

            except Exception as e:
                print(f"[DB SYNC ERROR] {e}")

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

    def _detection_callback(self, device: BleakDevice, advertisement_data):
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
        self.discovered[logical_mac] = {
            "device": device,
            "rssi": rssi,
            "seen": now,
            "ble_address": ble_address,
            "local_name": local_name,
            "match_priority": match_priority,
        }

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
                scanner = BleakScanner(detection_callback=self._detection_callback)
                await scanner.start()
                self.scanner = scanner
                self.scanner_started_at = time.time()
                print("[BLE] Persistent scanner started")
                return True
            except Exception as e:
                print(f"[BLE] Scanner start failed: {e}")
                self.scanner = None
                self.scanner_started_at = 0.0
                return False

    async def stop_scanner(self):
        """Stop persistent scanning and leave both local and BlueZ state clean."""
        async with self.scanner_control_lock:
            await self._stop_scanner_locked(force_bluez=False)

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

    async def connect_and_monitor(self, mac: str, ble_device):
        """Connect to a device and start monitoring, with retry logic."""
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

        for attempt in range(1, max_retry + 1):
            if self.shutdown_event.is_set():
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

            candidate_device = current_info.get("device", ble_device)
            candidate_address = current_info.get("ble_address", ble_address)
            if candidate_address != ble_address:
                ble_address = candidate_address
                print(f"    [BLE] Refreshed BLE address: {ble_address}")
            candidate_seen = float(current_info.get("seen") or 0)

            # Pause discovery while BlueZ establishes the connection and discovers
            # services. This is important for JStyle as well as Wear OS; scanning
            # during GATT discovery causes intermittent service-discovery drops.
            if self.scanner:
                await self.stop_scanner()
                await asyncio.sleep(1.0)

            async with self.ble_adapter_lock:
                try:
                    if driver.mode == DRIVER_MODE_WEAROS:
                        # Keep this as close as possible to the direct Wear OS test that works.
                        # Some Android/Wear OS peripherals disconnect during service discovery
                        # when a BlueZ disconnected_callback is registered too early.
                        client = BleakClient(candidate_device, timeout=BLE_CONNECT_TIMEOUT)
                    else:
                        client = BleakClient(
                            candidate_device,
                            timeout=BLE_CONNECT_TIMEOUT,
                            disconnected_callback=self._on_disconnect_callback(mac),
                        )
                    await client.connect()

                    if client.is_connected:
                        print(f"[BLE] Connected to {mac} (attempt {attempt})")
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

                        # Scanning remains stopped through connection and GATT discovery. The
                        # Wear OS monitor restarts it after notify is ready so advertisement-only
                        # devices can continue publishing.

                        # Start monitoring task based on device protocol
                        monitor_by_mode = {
                            DRIVER_MODE_WEAROS: self._keep_monitoring_wearos,
                            DRIVER_MODE_JSTYLE: self._keep_monitoring,
                            DRIVER_MODE_STANDARD_GATT: self._keep_monitoring_standard_gatt,
                        }
                        monitor = monitor_by_mode.get(driver.mode)
                        if monitor is None:
                            raise RuntimeError(f"Device driver {device_type} does not support a GATT connection")
                        ready_event = asyncio.Event()
                        state["monitor_ready_event"] = ready_event
                        state["monitor_setup_error"] = None
                        state["task"] = asyncio.create_task(
                            monitor(client, mac)
                        )

                        # Keep connection setup serialized until notification
                        # subscription is complete. This prevents another device
                        # from restarting discovery in the middle of GATT setup.
                        try:
                            await asyncio.wait_for(ready_event.wait(), timeout=GATT_SETUP_TIMEOUT)
                        except asyncio.TimeoutError:
                            print(f"[BLE] {mac}: GATT notification setup timed out")
                            state["task"].cancel()
                            return

                        if state.get("monitor_setup_error"):
                            print(f"[BLE] {mac}: GATT setup failed: {state['monitor_setup_error']}")
                        return

                except BleakError as e:
                    err_str = str(e)
                    print(f"[BLE] Connect error for {mac} (attempt {attempt}): {e}")

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

                        return

                except Exception as e:
                    print(f"[BLE] Connect exception for {mac} (attempt {attempt}): {e}")

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

    # ----------------------------------------------------------
    # KEEP MONITORING (Wear OS GATT)
    # ----------------------------------------------------------

    async def _keep_monitoring(self, client: BleakClient, mac: str):
        """Main monitoring loop for an iStyle/JStyle device (command-based protocol)."""
        state = self.device_state[mac]
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
            await client.start_notify(CHAR_RX, lambda _ch, data: self._on_notification(mac, data))
            ready_event = state.get("monitor_ready_event")
            if ready_event:
                ready_event.set()

            # Wait for notification setup
            await asyncio.sleep(2.0)

            # Phase 1: HR + Temp loop
            completed_cycles = 0
            while client.is_connected and not self.shutdown_event.is_set():
                await self._phase1_hr_temp(client, mac, metadata)

                if not client.is_connected or self.shutdown_event.is_set():
                    break

                # Phase 2: SpO2
                spo2_received = await self._phase2_spo2(client, mac)

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
                if completed_cycles >= JSTYLE_CYCLES_PER_CONNECTION:
                    state["monitor_fail_count"] = 0
                    cycle_seconds = max(0.0, time.time() - float(state.get("cycle_started_at") or time.time()))
                    print(
                        f"[BLE] {mac}: completed {completed_cycles} measurement cycle(s); "
                        f"rotating adapter slot (cycle_seconds={cycle_seconds:.1f})"
                    )
                    break

        except Exception as e:
            state["monitor_setup_error"] = str(e)
            state["monitor_failed"] = True
            state["monitor_fail_count"] = state.get("monitor_fail_count", 0) + 1
            print(f"[BLE] Monitoring error for {mac}: {e}")
        finally:
            ready_event = state.get("monitor_ready_event")
            if ready_event:
                ready_event.set()
            print(f"[BLE] Monitoring ended for {mac}")
            # Safe disconnect: acquire lock first to prevent race with scan/connect
            lock_acquired = False
            try:
                await asyncio.wait_for(self.ble_adapter_lock.acquire(), timeout=10.0)
                lock_acquired = True
            except (asyncio.TimeoutError, Exception) as e:
                print(f"    ⚠️ {mac}: lock acquire error: {e}")

            try:
                if client.is_connected:
                    try:
                        await self._write_jstyle_command(client, mac, "HR/Temp stop", 0x09, 0x00, 0x00, 0x00)
                    except Exception:
                        pass
                    print(f"    ⏳ {mac} disconnecting safely...")
                    await asyncio.wait_for(client.disconnect(), timeout=5.0)
            except Exception as e:
                print(f"    ⚠️ Safe disconnect error {mac}: {e}")
            finally:
                if lock_acquired:
                    self.ble_adapter_lock.release()
                # Short delay to let BlueZ cleanup before next scan
                await asyncio.sleep(1.5)
                state["connected"] = False
                state["task"] = None
                cooldown = (
                    self._retry_backoff(state.get("monitor_fail_count", 1))
                    if state.get("monitor_failed")
                    else JSTYLE_ROTATION_COOLDOWN
                )
                state["cooldown_until"] = max(
                    float(state.get("cooldown_until") or 0),
                    time.time() + cooldown,
                )
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
        if extracted.get("raw_provider") == "jstyle_0x28":
            state["spo2_last_progress_at"] = packet_received_at

        if state.get("monitor_phase") == "hr_temp" and extracted.get("status") == 1:
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
        if raw_status == 1:
            state["off_wrist_confirmation_count"] = 0
            state["is_wearing"] = 1
        elif raw_status == 0:
            confirmations = state.get("off_wrist_confirmation_count", 0) + 1
            state["off_wrist_confirmation_count"] = confirmations
            if state.get("monitor_phase") == "spo2":
                # Never leave a previous SpO2 result marked ready after the
                # optical stream reports off-wrist, even on its first packet.
                state["spo2_off_wrist_seen"] = True
                state["spo2_candidate"] = 0
                state["spo2_candidate_count"] = 0
                state["spo2_samples"] = []
                state["spo2_ready"] = False
            if confirmations < JSTYLE_OFF_WRIST_CONFIRMATIONS:
                # Optical transitions occasionally emit one status=0 packet.
                # Do not let a transient packet blank every dashboard metric.
                extracted.pop("status", None)
                for field in ("hr", "spo2", "temp"):
                    extracted.pop(field, None)
                print(
                    f"  [JStyle] {mac}: off-wrist confirmation "
                    f"{confirmations}/{JSTYLE_OFF_WRIST_CONFIRMATIONS}"
                )
            else:
                state["is_wearing"] = 0
                if state.get("monitor_phase") == "spo2":
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

    async def _write_jstyle_command(
        self,
        client: BleakClient,
        mac: str,
        label: str,
        *values: int,
    ) -> None:
        """Write one valid JStyle command and log the exact transmitted frame."""
        frame = build_jstyle_command(*values)
        print(f"  [JStyle TX] {mac} {label}: {frame.hex()}")
        await client.write_gatt_char(CHAR_TX, frame)

    async def _keep_monitoring_wearos(self, client: BleakClient, mac: str):
        """Main monitoring loop for a Wear OS device acting as BLE Peripheral."""
        state = self.device_state[mac]

        try:
            print(f"[BLE] Starting Wear OS monitoring for {mac}")

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

            while client.is_connected and not self.shutdown_event.is_set():
                await asyncio.sleep(1)

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
                await asyncio.wait_for(self.ble_adapter_lock.acquire(), timeout=10.0)
                lock_acquired = True
            except (asyncio.TimeoutError, Exception) as e:
                print(f"    ⚠️ {mac}: lock acquire error: {e}")

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
                    self.ble_adapter_lock.release()
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
        """Handle JSON vitals notification from Wear OS."""
        state = self.device_state.get(mac, {})
        state["last_data_timestamp"] = time.time()
        if JSTYLE_VERBOSE_SENSOR_LOGS:
            print(f"  [WearOS RAW] {mac}: {data.decode('utf-8', errors='ignore')}")
        extracted = WearOSDeviceHandler.parse_vitals(mac, data)

        if extracted:
            state["wearos_last_vitals_at"] = time.time()
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
                await asyncio.wait_for(self.ble_adapter_lock.acquire(), timeout=10.0)
                lock_acquired = True
            except (asyncio.TimeoutError, Exception) as e:
                print(f"    ⚠️ {mac}: lock acquire error: {e}")

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
                    self.ble_adapter_lock.release()
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
        metadata = self.device_registry.device_metadata.get(mac, {})
        self.vitals_publisher.publish_vitals(mac, extracted, metadata)

        values = ", ".join(
            f"{key.upper()}={value}"
            for key, value in extracted.items()
            if key in ("hr", "spo2", "temp", "batt")
        )
        if values and JSTYLE_VERBOSE_SENSOR_LOGS:
            print(f"  [Standard GATT] {mac}: {values}")

    async def _phase1_hr_temp(self, client: BleakClient, mac: str, metadata: dict):
        """Phase 1: Read HR and Temperature."""
        self._set_monitor_phase(mac, "hr_temp", PHASE_1_DURATION)
        state = self.device_state[mac]
        phase_started = time.time()
        state["phase_hr_samples"] = []
        state["phase_temp_samples"] = []
        state["phase_first_hr_at"] = 0
        state["phase_first_temp_at"] = 0
        print(
            f"[BLE] {mac}: Phase 1 — HR/Temp stream started "
            f"(minimum={PHASE_1_MIN_DURATION}s, hard_timeout={PHASE_1_DURATION}s)"
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

        for _ in range(PHASE_1_DURATION):
            if not client.is_connected or self.shutdown_event.is_set():
                break

            now = time.time()
            elapsed = now - phase_started
            if self._phase1_ready(state, elapsed):
                first_hr_latency = max(0.0, float(state.get("phase_first_hr_at") or now) - phase_started)
                first_temp_latency = max(0.0, float(state.get("phase_first_temp_at") or now) - phase_started)
                print(
                    f"[BLE] {mac}: HR/Temp stable; ending phase early "
                    f"(elapsed={elapsed:.1f}s, first_hr={first_hr_latency:.1f}s, "
                    f"first_temp={first_temp_latency:.1f}s, samples={len(state['phase_hr_samples'])})"
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
        if client.is_connected and not self.shutdown_event.is_set() and not self._phase1_ready(state, phase_elapsed):
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

    async def _phase2_spo2(self, client: BleakClient, mac: str) -> bool:
        """Measure SpO2 once from one isolated, continuous optical stream."""
        state = self.device_state[mac]
        metadata = (
            self.device_registry.device_metadata.get(mac, {})
            if self.device_registry is not None else {}
        )

        if state.get("is_wearing") == 0:
            print(f"[BLE] {mac}: Skipping SpO2 phase because device is explicitly off-wrist")
            return False
        queue_started = time.time()
        self._set_monitor_phase(mac, "spo2_queue", self._spo2_queue_timeout())
        print(f"[BLE] {mac}: waiting for isolated SpO2 measurement slot")

        async with self.jstyle_measurement_lock:
            if not client.is_connected or self.shutdown_event.is_set():
                return False

            queue_wait = max(0.0, time.time() - queue_started)
            print(
                f"[BLE] {mac}: Phase 2 — isolated single-shot SpO2 measurement "
                f"(queue_wait={queue_wait:.1f}s)"
            )
            state["spo2_quality"] = "measuring"
            state["spo2_off_wrist_seen"] = False
            state["spo2_off_wrist_confirmed"] = False
            state["spo2_ready"] = False
            state["last_spo2_value"] = 0
            state["spo2_candidate"] = 0
            state["spo2_candidate_count"] = 0
            state["spo2_samples"] = []
            state["spo2_warmup_remaining"] = SPO2_WARMUP_SAMPLES
            state["spo2_last_progress_at"] = 0
            self.vitals_publisher.publish_spo2_quality(mac, "measuring", metadata)

            if JSTYLE_ENABLE_MEASURE_COMMANDS:
                try:
                    await self._write_jstyle_command(
                        client, mac, "HR/Temp stop", 0x09, 0x00, 0x00, 0x00
                    )
                except Exception as e:
                    err_str = str(e).lower()
                    if "not connected" in err_str or "unknownobject" in err_str or "not found" in err_str:
                        raise ConnectionError(f"Connection lost to {mac}: {e}")

            self._set_monitor_phase(
                mac, "spo2_settle", SPO2_SENSOR_SETTLE_SECONDS + PHASE_2_TIMEOUT
            )
            await asyncio.sleep(SPO2_SENSOR_SETTLE_SECONDS)

            scanner_was_running = self.scanner is not None
            try:
                if scanner_was_running:
                    await self.stop_scanner()

                async with self.ble_adapter_lock:
                    if not client.is_connected or self.shutdown_event.is_set():
                        return False

                    self._set_monitor_phase(mac, "spo2", PHASE_2_TIMEOUT)
                    print(
                        f"[BLE] {mac}: SpO2 stream started once "
                        "(waiting for device final result)"
                    )

                    if JSTYLE_ENABLE_MEASURE_COMMANDS:
                        try:
                            await self._write_jstyle_command(
                                client, mac, "SpO2 start", 0x28, 0x03, 0x01
                            )
                        except Exception as e:
                            if "not connected" not in str(e).lower():
                                print(f"    ⚠️ {mac}: SpO2 start command error: {e}")
                            return False

                    try:
                        stream_started_at = time.time()
                        for _ in range(PHASE_2_TIMEOUT):
                            if not client.is_connected or self.shutdown_event.is_set():
                                break
                            if state.get("spo2_ready"):
                                print(f"[BLE] {mac}: stable SpO2 window complete")
                                break
                            if state.get("spo2_off_wrist_confirmed"):
                                print(f"[BLE] {mac}: confirmed off-wrist; ending SpO2 early")
                                break
                            last_progress = float(state.get("spo2_last_progress_at") or 0)
                            progress_reference = last_progress or stream_started_at
                            if time.time() - progress_reference >= SPO2_NO_PROGRESS_TIMEOUT:
                                print(
                                    f"[BLE] {mac}: SpO2 no progress for "
                                    f"{SPO2_NO_PROGRESS_TIMEOUT}s; ending stream early"
                                )
                                break
                            await asyncio.sleep(1)
                    finally:
                        if JSTYLE_ENABLE_MEASURE_COMMANDS and client.is_connected:
                            try:
                                await self._write_jstyle_command(
                                    client, mac, "SpO2 stop", 0x28, 0x03, 0x00
                                )
                            except Exception:
                                pass
                        state["last_spo2_end_time"] = time.time()
            finally:
                if (
                    scanner_was_running
                    and not self.shutdown_event.is_set()
                    and self._connection_budget_has_capacity()
                    and not self.scanner
                ):
                    try:
                        await self.start_scanner()
                    except Exception:
                        pass

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
            print(f"[BLE] {mac}: SpO2 verified={verified}% ({level}, single stream)")
            return True

        samples_seen = len(state.get("spo2_samples", []))
        quality = "unstable" if samples_seen else (
            "off_wrist" if state.get("spo2_off_wrist_seen") else "timeout"
        )
        state["spo2_quality"] = quality
        state["last_spo2_value"] = 0
        self.vitals_publisher.publish_spo2_quality(
            mac, quality, metadata,
            samples=samples_seen,
        )
        print(f"[BLE] {mac}: SpO2 {quality} after one stream ({samples_seen} samples)")
        return samples_seen > 0

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
        try:
            proc = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=timeout)
            return proc.returncode == 0
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
            # the new connection budget.
            await self._run_shell(
                "bluetoothctl devices Connected | awk '{print $2}' | "
                "while read address; do bluetoothctl disconnect \"$address\" >/dev/null 2>&1 || true; done",
                timeout=10.0,
            )
            await asyncio.sleep(1.0)
            proc = await asyncio.create_subprocess_shell(
                "busctl call org.bluez /org/bluez/hci0 org.bluez.Adapter1 StopDiscovery",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                await asyncio.wait_for(proc.communicate(), timeout=5.0)
            except asyncio.TimeoutError:
                pass
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

    async def _connection_watchdog(self):
        """Monitor connections and recover an orphaned/stalled scanner."""
        while not self.shutdown_event.is_set():
            await asyncio.sleep(WATCHDOG_INTERVAL)
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

            active_connections = self._active_connection_count()
            critical = self.jstyle_measurement_lock.locked()
            advertisement_age = max(0.0, now - self.last_advertisement_timestamp)
            discovering = await self._get_discovery_status()

            if self._scanner_data_plane_stale(now):
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

            self.controller_heartbeat = now
            self._write_health_state(discovering)

    # ----------------------------------------------------------
    # MAIN CONTROLLER
    # ----------------------------------------------------------

    async def main_controller(self):
        """Main BLE controller loop."""
        print("[BLE] Starting main controller...")

        # Startup adapter cleanup (prevents first-run InProgress)
        await self._startup_adapter_cleanup()

        if not await self.start_scanner():
            print("[BLE] Scanner failed to start — entering recovery")
            await self._recover_from_inprogress()

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

                for mac in found_targets:
                    if self.shutdown_event.is_set():
                        break
                    meta = self.device_registry.device_metadata.get(mac, {})
                    device_type = meta.get("device_type", "jstyle")
                    driver = DRIVER_REGISTRY.get(device_type)
                    if self.jstyle_measurement_lock.locked():
                        # The JStyle optical measurement owns the adapter for a
                        # short critical window. Keep scanning and remembering
                        # Wear OS advertisements, then connect the prioritized
                        # Wear OS target as soon as this window closes.
                        continue

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

                    if driver.mode in {
                        DRIVER_MODE_ADVERTISEMENT,
                        DRIVER_MODE_EXTERNAL,
                        DRIVER_MODE_UNSUPPORTED,
                    }:
                        continue

                    if driver.mode == DRIVER_MODE_JSTYLE and not JSTYLE_CONNECT_FOR_GATT:
                        # J2208A devices publish through manufacturer data only in this mode.
                        continue

                    if not self._can_start_gatt_connection(mac):
                        continue

                    info = self.discovered.get(mac)
                    if not info:
                        continue

                    ble_device = info["device"]
                    await self.connect_and_monitor(mac, ble_device)
                    if (
                        not self.shutdown_event.is_set()
                        and (BLE_SCAN_DURING_WEAROS or not self.jstyle_measurement_lock.locked())
                        and self._connection_budget_has_capacity()
                        and not self.scanner
                    ):
                        await self.start_scanner()
                        # Give BlueZ time to create fresh object paths before the
                        # next target from this controller pass is considered.
                        await asyncio.sleep(0.75)

                # Scanner ownership stays in the controller so monitor tasks
                # cannot restart discovery during another device's GATT setup.
                if (
                    not self.shutdown_event.is_set()
                    and (BLE_SCAN_DURING_WEAROS or not self.jstyle_measurement_lock.locked())
                    and self._connection_budget_has_capacity()
                    and not self.scanner
                ):
                    await self.start_scanner()

                if self.scanner and not self._connection_budget_has_capacity():
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
