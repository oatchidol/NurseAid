#!/usr/bin/env python3
"""
NurseAid MQTT Bridge - MQTT to InfluxDB Bridge
================================================
รับข้อมูลจาก MQTT topics ที่กำหนด และบันทึกลง InfluxDB

Author: NurseAid Team
Version: 1.0
"""

import os
import time
import json
import threading
from pathlib import Path
from esp32_topology import Esp32TopologyRegistry
import paho.mqtt.client as mqtt
from influxdb_client import InfluxDBClient, Point
from influxdb_client.client.write_api import SYNCHRONOUS

# ============================================================
# Configuration from Environment Variables
# ============================================================
# Credentials are REQUIRED at runtime and intentionally have no baked-in
# placeholder values. A missing secret aborts startup so the container fails
# fast with a clear message instead of silently using a known password/token.
def _required_env(name):
    value = os.getenv(name, "").strip()
    if not value:
        raise SystemExit(
            f"❌ Fatal: required environment variable {name!r} is not set.\n"
            f"   The {name} secret MUST be supplied at run time (e.g. via the "
            f"Compose service `environment`/`env_file`). Refusing to start."
        )
    return value


INFLUX_URL = os.getenv("INFLUX_URL", "http://localhost:8086").rstrip("/")
INFLUX_TOKEN = _required_env("INFLUX_TOKEN")
INFLUX_ORG = _required_env("INFLUX_ORG")
INFLUX_BUCKET = _required_env("INFLUX_BUCKET")

MQTT_HOST = os.getenv("MQTT_HOST", "host.docker.internal")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_USER = _required_env("MQTT_USER")
MQTT_PASSWORD = _required_env("MQTT_PASSWORD")
MQTT_TOPICS = [t for t in os.getenv("MQTT_TOPICS", "ble/#").split(",") if t.strip()]

SAVE_INTERVAL = max(1, int(os.getenv("SAVE_INTERVAL", "5")))
VERBOSE_SENSOR_LOGS = os.getenv("VERBOSE_SENSOR_LOGS", "false").strip().lower() in {"1", "true", "yes", "on"}
HEALTH_FILE = Path(os.getenv("MQTT_BRIDGE_HEALTH_FILE", "/tmp/nurseaid-mqtt-bridge-health.json"))
MQTT_TOPOLOGY_FILE = Path(os.getenv("NURSEAID_MQTT_TOPOLOGY_FILE", "/run/nurseaid-compose/mqtt-sensors.json"))
MQTT_ESP32_STALE_SECONDS = max(5, int(os.getenv("NURSEAID_MQTT_ESP32_STALE_SECONDS", "90")))
MQTT_TOPOLOGY_SETTLE_SECONDS = max(1, int(os.getenv("NURSEAID_MQTT_TOPOLOGY_SETTLE_SECONDS", "30")))

# ============================================================
# Initialize InfluxDB Client
# ============================================================
influx_client = InfluxDBClient(url=INFLUX_URL, token=INFLUX_TOKEN, org=INFLUX_ORG)
write_api = influx_client.write_api(write_options=SYNCHRONOUS)

# ============================================================
# Data Buffer
# data_buffer[topic][mac] = {"field_name": field_value}
# ============================================================
data_buffer = {}
data_buffer_lock = threading.Lock()
last_saved_time = time.time()
last_message_time = 0.0
last_write_success = time.time()
mqtt_connected = False
consecutive_write_failures = 0
esp32_topology = Esp32TopologyRegistry(
    MQTT_TOPOLOGY_FILE,
    stale_seconds=MQTT_ESP32_STALE_SECONDS,
    settle_seconds=MQTT_TOPOLOGY_SETTLE_SECONDS,
)


def event_metadata(data):
    now = time.time()
    try:
        sample_ms = int(float(data.get("sample_epoch_ms")))
        if sample_ms <= 0 or sample_ms > int((now + 300) * 1000):
            raise ValueError
    except (TypeError, ValueError):
        sample_ms = int(now * 1000)
    return {"_timestamp_ns": sample_ms * 1_000_000, "_received_at": now}


def buffered_fields(fields, data):
    return {**fields, **event_metadata(data)}


def write_health():
    now = time.time()
    with data_buffer_lock:
        pending = sum(len(devices) for devices in data_buffer.values())
    payload = {
        "timestamp": now,
        "mqttConnected": mqtt_connected,
        "lastMessageAgeSeconds": round(now - last_message_time, 1) if last_message_time else None,
        "lastWriteSuccessAgeSeconds": round(now - last_write_success, 1),
        "pendingRecords": pending,
        "consecutiveWriteFailures": consecutive_write_failures,
        "healthy": bool(mqtt_connected and consecutive_write_failures < 3),
    }
    try:
        temporary = HEALTH_FILE.with_suffix(".tmp")
        temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        temporary.replace(HEALTH_FILE)
    except OSError:
        pass

# A legacy gateway still present on the LAN publishes placeholder zeroes every
# second using only {value, mac, time, uuid}.  Those placeholders can overwrite
# a real JStyle reading in this bridge's per-MAC buffer before it is persisted.
# Keep status=0 (offline/not wearing) and battery=0 (valid empty battery), but
# reject impossible clinical zeroes only when the payload has no provenance.
LEGACY_ZERO_PLACEHOLDER_TOPICS = {"ble/heart", "ble/spo2", "ble/temp"}


def is_legacy_zero_placeholder(topic, data):
    if topic not in LEGACY_ZERO_PLACEHOLDER_TOPICS:
        return False
    if any(data.get(key) not in (None, "") for key in ("provider", "source", "device_id")):
        return False
    try:
        return float(data.get("value")) <= 0
    except (TypeError, ValueError):
        return False

# ============================================================
# MQTT Callbacks
# ============================================================

def on_connect(client, userdata, flags, rc):
    """Called when MQTT connection is established."""
    global mqtt_connected
    mqtt_connected = rc == 0
    if rc == 0:
        print("✅ MQTT Connected! NurseAid MQTT Bridge Running...")
        for topic in MQTT_TOPICS:
            client.subscribe(topic.strip())
            print(f"   Subscribed to: {topic.strip()}")
    else:
        print(f"❌ MQTT Connection failed: {rc}")


# ============================================================
# MAC Address Validation
# ============================================================
import re as _re

_MAC_RE = _re.compile(
    r"^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$|^[0-9a-f]{2}(?:-[0-9a-f]{2}){5}$",
    _re.IGNORECASE,
)


def validate_and_normalize_mac(value):
    """Return a canonical lowercase MAC or None if the value is invalid.

    Invalid includes missing, blank, non-string, or anything that does not look
    like a 6-byte colon/dash separated address. Rejecting would-be MACs here
    prevents malformed/rogue publishers from creating a shared 'unknown' series
    in InfluxDB and clobbering one another's in-memory buffer.
    """
    if not isinstance(value, str):
        return None
    mac = value.strip().lower()
    if not mac or not _MAC_RE.match(mac):
        return None
    # Normalize to a single canonical separator (colon).
    if "-" in mac:
        mac = mac.replace("-", ":")
    return mac


def _on_message(client, userdata, msg):
    """Called when a MQTT message is received."""
    topic = msg.topic
    payload = msg.payload.decode().strip()

    global last_message_time
    last_message_time = time.time()
    try:
        if topic.startswith("ble/"):
            data_json = json.loads(payload)
            if not isinstance(data_json, dict):
                print(f"   ⚠️ Ignored non-object payload on {topic}: {payload[:300]}")
                return

            if topic == "ble/esp32":
                # Board/JStyle inventory is topology, not a numeric sensor point.
                # One message is a full snapshot for one ESP32 board.
                esp32_topology.apply(data_json)
                if VERBOSE_SENSOR_LOGS:
                    print(
                        f"   🧩 ESP32 topology: node={data_json.get('node_id')}, "
                        f"board={data_json.get('mac')}, devices={data_json.get('count')}"
                    )
                return

            mac = validate_and_normalize_mac(data_json.get("mac"))
            if mac is None:
                if VERBOSE_SENSOR_LOGS:
                    print(f"   🗑️ Dropped {topic}: missing/invalid MAC id")
                return

            if topic not in data_buffer:
                data_buffer[topic] = {}

            if topic == "ble/patient":
                # Patient info (String fields)
                data_buffer[topic][mac] = {
                    "name": data_json.get("name", "unknown"),
                    "hn": data_json.get("hn", "unknown")
                }
                if VERBOSE_SENSOR_LOGS:
                    print(f"   🧑‍⚕️ Patient: MAC={mac}, Name={data_json.get('name')}, HN={data_json.get('hn')}")

            elif topic == "ble/spo2_quality":
                quality = str(data_json.get("status") or "unavailable").strip().lower()
                if quality not in {"measuring", "verified", "unstable", "timeout", "off_wrist", "unavailable"}:
                    quality = "unavailable"
                data_buffer[topic][mac] = buffered_fields({"status": quality}, data_json)
                for field in ("value", "rounds", "spread"):
                    value = data_json.get(field)
                    if value is not None:
                        try:
                            data_buffer[topic][mac][field] = float(value)
                        except (TypeError, ValueError):
                            pass
                if VERBOSE_SENSOR_LOGS:
                    print(f"   🫁 SpO2 quality: MAC={mac}, Status={quality}")

            elif topic == "ble/vitals":
                # Consolidated vitals from gateway - extract each field separately
                # Fields: hr, spo2, temp, batt, status
                try:
                    wearable_status = int(float(data_json.get("status")))
                except (TypeError, ValueError):
                    wearable_status = None
                spo2_status = str(data_json.get("spo2_status") or "").strip().lower()

                vitals_map = {
                    "hr": ("heart", "heart_rate"),
                    "spo2": ("spo2", "spo2_level"),
                    "temp": ("temp", "temperature"),
                    "batt": ("batt", "battery"),
                    "status": ("status", "status"),
                }
                
                for field, (measurement, influx_field) in vitals_map.items():
                    value = data_json.get(field)
                    # Upstream devices are responsible for their quality gate, so
                    # this bridge must not double-filter accepted vital values.
                    if field == "spo2" and data_json.get("provider") == "jstyle" and spo2_status != "verified":
                        if VERBOSE_SENSOR_LOGS:
                            print(f"   🗑️ Ignored unverified JStyle SpO2: MAC={mac}, Status={spo2_status or 'missing'}")
                        continue
                    if value is not None and value != "null" and value != "":
                        try:
                            float_val = float(value)
                            # Create a combined topic for this measurement type
                            combined_topic = f"ble/{measurement}"
                            if combined_topic not in data_buffer:
                                data_buffer[combined_topic] = {}
                            data_buffer[combined_topic][mac] = buffered_fields(
                                {"value": float_val}, data_json
                            )
                            if field == "status" and data_json.get("activity"):
                                data_buffer[combined_topic][mac]["activity"] = data_json.get("activity")
                            if VERBOSE_SENSOR_LOGS:
                                print(f"   📡 Vitals: MAC={mac}, {measurement}={float_val}")
                        except (ValueError, TypeError):
                            pass

                # Activity is stored in the status measurement but must not
                # invent or refresh a wear-status value. This lets the dashboard
                # show "connecting"/"measuring" while retaining the last actual
                # status=0/1 point at its original timestamp.
                activity = str(data_json.get("activity") or "").strip()
                if activity:
                    status_fields = {"activity": activity}
                    if wearable_status in (0, 1):
                        status_fields["value"] = float(wearable_status)
                    data_buffer.setdefault("ble/status", {})[mac] = buffered_fields(
                        status_fields, data_json
                    )

            else:
                # Legacy sensor data (single value format)
                if topic == "ble/spo2" and data_json.get("provider") == "jstyle" and data_json.get("quality") != "verified":
                    if VERBOSE_SENSOR_LOGS:
                        print(f"   🗑️ Ignored unverified legacy JStyle SpO2: MAC={mac}")
                    return
                if topic in LEGACY_ZERO_PLACEHOLDER_TOPICS:
                    try:
                        if int(float(data_json.get("status"))) == 0:
                            if VERBOSE_SENSOR_LOGS:
                                print(f"   🗑️ Ignored off-wrist clinical value: MAC={mac}, Type={topic}")
                            return
                    except (TypeError, ValueError):
                        pass
                if is_legacy_zero_placeholder(topic, data_json):
                    if VERBOSE_SENSOR_LOGS:
                        print(f"   🗑️ Ignored legacy zero placeholder: MAC={mac}, Type={topic}")
                    return
                data_buffer[topic][mac] = buffered_fields(
                    {"value": float(data_json.get("value", 0))}, data_json
                )
                if VERBOSE_SENSOR_LOGS:
                    print(f"   📡 Sensor: MAC={mac}, Type={topic}, Value={data_json.get('value')}")

    except json.JSONDecodeError:
        print(f"   ⚠️ Invalid JSON from {topic}: {payload}")
    except Exception as e:
        print(f"   ⚠️ Error parsing message: {e}")


def on_message(client, userdata, msg):
    """Serialize buffer mutations against the periodic atomic buffer swap."""
    with data_buffer_lock:
        _on_message(client, userdata, msg)


def on_disconnect(client, userdata, rc):
    """Called when MQTT connection is lost."""
    global mqtt_connected
    mqtt_connected = False
    if rc != 0:
        print(f"⚠️ MQTT Unexpected disconnect (rc={rc}), will reconnect...")
    else:
        print("ℹ️ MQTT Disconnected normally")


# ============================================================
# Save Data to InfluxDB
# ============================================================

def save_data():
    """Atomically drain the buffer and write all points in one Influx request."""
    global data_buffer, last_saved_time, last_write_success, consecutive_write_failures
    current_time = time.time()

    if current_time - last_saved_time < SAVE_INTERVAL:
        return

    with data_buffer_lock:
        pending = data_buffer
        data_buffer = {}

    if not pending:
        last_saved_time = current_time
        return

    try:
        points = []
        for topic, devices in pending.items():
            measurement = topic.replace("ble/", "ble_").rstrip("/")
            for mac, fields_dict in devices.items():
                timestamp_ns = int(fields_dict.get("_timestamp_ns") or time.time_ns())
                point = Point(measurement).tag("mac", mac).time(timestamp_ns)
                for field_name, field_value in fields_dict.items():
                    if field_name.startswith("_"):
                        continue
                    point = point.field(field_name, field_value)
                points.append(point)

        if points:
            write_api.write(bucket=INFLUX_BUCKET, org=INFLUX_ORG, record=points)
            last_write_success = current_time
            consecutive_write_failures = 0
            print(f"   🚀 [{time.strftime('%H:%M:%S')}] Saved {len(points)} records to InfluxDB (batch)")
    except Exception as e:
        consecutive_write_failures += 1
        print(f"   ❌ Error saving to InfluxDB: {e}")
        # Preserve the newest callback value for each topic/MAC while restoring
        # failed records that have no newer replacement.
        with data_buffer_lock:
            for topic, devices in pending.items():
                current_devices = data_buffer.setdefault(topic, {})
                for mac, fields in devices.items():
                    current_devices.setdefault(mac, fields)

    last_saved_time = current_time
    write_health()


# ============================================================
# Main
# ============================================================

def main():
    print("=" * 60)
    print("  NurseAid MQTT Bridge - MQTT to InfluxDB")
    print("=" * 60)
    print(f"  InfluxDB: {INFLUX_URL}")
    print(f"  Token:    {INFLUX_TOKEN[:10]}...")
    print(f"  Org:      {INFLUX_ORG}")
    print(f"  Bucket:   {INFLUX_BUCKET}")
    print(f"  MQTT:     {MQTT_HOST}:{MQTT_PORT}")
    print(f"  User:     {MQTT_USER}")
    print(f"  Topics:   {', '.join(MQTT_TOPICS)}")
    print(f"  Save:     Every {SAVE_INTERVAL} seconds")
    print("=" * 60)

    # Create MQTT Client
    client = mqtt.Client(client_id="NurseAid_MQTT_Bridge")
    client.username_pw_set(username=MQTT_USER, password=MQTT_PASSWORD)
    client.on_connect = on_connect
    client.on_message = on_message
    client.on_disconnect = on_disconnect
    client.reconnect_delay_set(min_delay=1, max_delay=30)

    # Start asynchronously so Paho keeps retrying if the broker is not ready yet.
    try:
        client.connect_async(MQTT_HOST, MQTT_PORT, 60)
        client.loop_start()
        print(f"\n⏳ MQTT connection started for {MQTT_HOST}:{MQTT_PORT}\n")
    except Exception as e:
        print(f"❌ Failed to connect to MQTT: {e}")
        raise

    try:
        while True:
            save_data()
            write_health()
            try:
                esp32_topology.write_snapshot()
            except OSError as error:
                print(f"   ⚠️ Failed to write ESP32 topology snapshot: {error}")
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n🛑 Shutting down gracefully...")
        client.loop_stop()
        influx_client.close()
        print("✅ Done")


if __name__ == "__main__":
    main()
