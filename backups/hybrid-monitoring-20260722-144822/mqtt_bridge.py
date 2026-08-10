#!/usr/bin/env python3
"""
NurseAid MQTT Bridge - MQTT to InfluxDB Bridge
================================================
รับข้อมูลจาก MQTT (ble/#) และบันทึกลง InfluxDB

Author: NurseAid Team
Version: 1.0
"""

import os
import time
import json
import threading
import paho.mqtt.client as mqtt
from influxdb_client import InfluxDBClient, Point
from influxdb_client.client.write_api import SYNCHRONOUS

# ============================================================
# Configuration from Environment Variables
# ============================================================
INFLUX_URL = os.getenv("INFLUX_URL", "http://localhost:8086")
INFLUX_TOKEN = os.getenv("INFLUX_TOKEN", "my-super-secret-auth-token!")
INFLUX_ORG = os.getenv("INFLUX_ORG", "softsquaregroup")
INFLUX_BUCKET = os.getenv("INFLUX_BUCKET", "naret2")

MQTT_HOST = os.getenv("MQTT_HOST", "host.docker.internal")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_USER = os.getenv("MQTT_USER", "nursemon")
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD", "NewSoft^2")
MQTT_TOPICS = os.getenv("MQTT_TOPICS", "ble/#").split(",")

SAVE_INTERVAL = max(1, int(os.getenv("SAVE_INTERVAL", "5")))
VERBOSE_SENSOR_LOGS = os.getenv("VERBOSE_SENSOR_LOGS", "false").strip().lower() in {"1", "true", "yes", "on"}

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
    if rc == 0:
        print("✅ MQTT Connected! NurseAid MQTT Bridge Running...")
        for topic in MQTT_TOPICS:
            client.subscribe(topic.strip())
            print(f"   Subscribed to: {topic.strip()}")
    else:
        print(f"❌ MQTT Connection failed: {rc}")


def _on_message(client, userdata, msg):
    """Called when a MQTT message is received."""
    topic = msg.topic
    payload = msg.payload.decode().strip()

    try:
        if topic.startswith("ble/"):
            data_json = json.loads(payload)
            mac = data_json.get("mac", "unknown")

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
                data_buffer[topic][mac] = {"status": quality}
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
                    if wearable_status == 0 and field in ("hr", "spo2", "temp"):
                        continue
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
                            data_buffer[combined_topic][mac] = {
                                "value": float_val
                            }
                            if VERBOSE_SENSOR_LOGS:
                                print(f"   📡 Vitals: MAC={mac}, {measurement}={float_val}")
                        except (ValueError, TypeError):
                            pass

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
                data_buffer[topic][mac] = {
                    "value": float(data_json.get("value", 0))
                }
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
    if rc != 0:
        print(f"⚠️ MQTT Unexpected disconnect (rc={rc}), will reconnect...")
    else:
        print("ℹ️ MQTT Disconnected normally")


# ============================================================
# Save Data to InfluxDB
# ============================================================

def save_data():
    """Atomically drain the buffer and write all points in one Influx request."""
    global data_buffer, last_saved_time
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
        timestamp_ns = time.time_ns()
        points = []
        for topic, devices in pending.items():
            measurement = topic.replace("ble/", "ble_").rstrip("/")
            for mac, fields_dict in devices.items():
                point = Point(measurement).tag("mac", mac).time(timestamp_ns)
                for field_name, field_value in fields_dict.items():
                    point = point.field(field_name, field_value)
                points.append(point)

        if points:
            write_api.write(bucket=INFLUX_BUCKET, org=INFLUX_ORG, record=points)
            print(f"   🚀 [{time.strftime('%H:%M:%S')}] Saved {len(points)} records to InfluxDB (batch)")
    except Exception as e:
        print(f"   ❌ Error saving to InfluxDB: {e}")
        # Preserve the newest callback value for each topic/MAC while restoring
        # failed records that have no newer replacement.
        with data_buffer_lock:
            for topic, devices in pending.items():
                current_devices = data_buffer.setdefault(topic, {})
                for mac, fields in devices.items():
                    current_devices.setdefault(mac, fields)

    last_saved_time = current_time


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
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n🛑 Shutting down gracefully...")
        client.loop_stop()
        influx_client.close()
        print("✅ Done")


if __name__ == "__main__":
    main()
