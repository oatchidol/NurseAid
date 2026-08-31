import importlib.util
import json
import os
import stat
import tempfile
import time
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("nurseaid-compose-collector.py")
SPEC = importlib.util.spec_from_file_location("nurseaid_compose_collector", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SensorSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "sensors.json"
        MODULE.SENSOR_STATUS_FILE = self.path
        MODULE.MQTT_SENSOR_STATUS_FILE = Path(self.directory.name) / "mqtt-sensors.json"
        MODULE.SENSOR_STATE_STALE_SECONDS = 15

    def tearDown(self):
        self.directory.cleanup()

    def write(self, value, age=0):
        self.path.write_text(json.dumps(value), encoding="utf-8")
        now = time.time()
        os.utime(self.path, (now - age, now - age))
        return now

    def test_missing_or_not_ready_omits_topology(self):
        self.assertIsNone(MODULE.sensor_snapshot())
        self.write({"topologyReady": False, "sensors": {}})
        self.assertIsNone(MODULE.sensor_snapshot())

    def test_ready_empty_is_authoritative(self):
        now = self.write({"topologyReady": True, "sensors": {}})
        self.assertEqual(MODULE.sensor_snapshot(now), {})

    def test_fresh_snapshot_adjusts_packet_age(self):
        value = {"topologyReady": True, "sensors": {"ESP32-A": {
            "status": "connected", "watches": [{"watchId": "A12", "status": "connected", "lastPacketAgeSeconds": 5}]
        }}}
        now = self.write(value, age=3)
        result = MODULE.sensor_snapshot(now)
        self.assertEqual(result["ESP32-A"]["status"], "connected")
        self.assertEqual(result["ESP32-A"]["watches"][0]["lastPacketAgeSeconds"], 8)

    def test_board_metadata_and_connected_jstyle_count_are_forwarded(self):
        value = {"topologyReady": True, "sensors": {"ESP32-A": {
            "status": "connected",
            "nodeId": "NODE_01",
            "ipAddress": "192.168.1.100",
            "boardMac": "84:F7:03:AE:02:94",
            "connectedJstyleCount": 2,
            "watches": [
                {"watchId": "10:20:30:40:50:60", "status": "connected"},
                {"watchId": "AA:BB:CC:DD:EE:FF", "status": "connected"},
            ],
        }}}
        now = self.write(value)
        result = MODULE.sensor_snapshot(now)["ESP32-A"]
        self.assertEqual(result["nodeId"], "NODE_01")
        self.assertEqual(result["ipAddress"], "192.168.1.100")
        self.assertEqual(result["boardMac"], "84:F7:03:AE:02:94")
        self.assertEqual(result["connectedJstyleCount"], 2)
        self.assertEqual([watch["watchId"] for watch in result["watches"]], [
            "10:20:30:40:50:60", "AA:BB:CC:DD:EE:FF",
        ])

    def test_connected_jstyle_count_mismatch_rejects_snapshot(self):
        value = {"topologyReady": True, "sensors": {"ESP32-A": {
            "status": "connected",
            "connectedJstyleCount": 2,
            "watches": [{"watchId": "10:20:30:40:50:60", "status": "connected"}],
        }}}
        now = self.write(value)
        self.assertIsNone(MODULE.sensor_snapshot(now))

    def test_stale_snapshot_preserves_topology_but_marks_unknown(self):
        value = {"topologyReady": True, "sensors": {"ESP32-A": {
            "status": "connected", "watches": [{"watchId": "A12", "status": "connected", "lastPacketAgeSeconds": 5}]
        }}}
        now = self.write(value, age=20)
        result = MODULE.sensor_snapshot(now)
        self.assertEqual(result["ESP32-A"]["status"], "unknown")
        self.assertEqual(result["ESP32-A"]["watches"][0]["status"], "unknown")
        self.assertEqual(result["ESP32-A"]["watches"][0]["lastPacketAgeSeconds"], 25)


class MqttConnectionTests(unittest.TestCase):
    def test_mqtt_connected_client_ips_reads_established_peers(self):
        proc_text = """  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 030012AC:075B 20FB10AC:FFFB 01 00000000:00000000 00:00000000 00000000  1883        0 1 1 0 0 0 0 0\n   1: 030012AC:075B 060012AC:8D04 01 00000000:00000000 00:00000000 00000000  1883        0 2 1 0 0 0 0 0\n   2: 030012AC:075B 210012AC:8D04 06 00000000:00000000 00:00000000 00000000  1883        0 3 1 0 0 0 0 0\n"""
        self.assertEqual(MODULE.mqtt_connected_client_ips(proc_text), ["172.16.251.32", "172.18.0.6"])


class StatusWriterTests(unittest.TestCase):
    def test_status_writer_can_refresh_independently_of_central_cycle(self):
        original_snapshot = MODULE.snapshot
        original_atomic_write = MODULE.atomic_write
        stop = __import__("threading").Event()
        writes = []
        try:
            MODULE.snapshot = lambda: {"schemaVersion": 2, "services": {}, "metrics": {}}

            def fake_write(value):
                writes.append(value)
                stop.set()

            MODULE.atomic_write = fake_write
            MODULE.status_writer_loop(stop)
            self.assertEqual(len(writes), 1)
            self.assertEqual(writes[0]["schemaVersion"], 2)
        finally:
            MODULE.snapshot = original_snapshot
            MODULE.atomic_write = original_atomic_write


class CredentialFileTests(unittest.TestCase):
    def test_new_central_credential_is_written_mode_0600(self):
        with tempfile.TemporaryDirectory() as directory:
            original_file = MODULE.CREDENTIAL_FILE
            original_http = MODULE.http_json_request
            original_url = MODULE.CENTRAL_URL
            original_until = MODULE._enrollment_backoff_until
            original_current = MODULE._enrollment_backoff_current
            original_logged = MODULE._last_enrollment_backoff_logged
            try:
                MODULE.CREDENTIAL_FILE = Path(directory) / "central-credential.json"
                MODULE.CENTRAL_URL = "https://central.example"
                MODULE._enrollment_backoff_until = 0.0
                MODULE._enrollment_backoff_current = 0
                MODULE._last_enrollment_backoff_logged = None
                MODULE.http_json_request = lambda *_args, **_kwargs: (201, {"credential": "secret-token"})

                self.assertEqual(MODULE.get_central_credential(), "secret-token")
                mode = stat.S_IMODE(MODULE.CREDENTIAL_FILE.stat().st_mode)
                self.assertEqual(mode, 0o600)
            finally:
                MODULE.CREDENTIAL_FILE = original_file
                MODULE.http_json_request = original_http
                MODULE.CENTRAL_URL = original_url
                MODULE._enrollment_backoff_until = original_until
                MODULE._enrollment_backoff_current = original_current
                MODULE._last_enrollment_backoff_logged = original_logged


class SensorSourcePriorityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        MODULE.MQTT_SENSOR_STATUS_FILE = root / "mqtt-sensors.json"
        MODULE.SENSOR_STATUS_FILE = root / "sensors.json"
        MODULE.SENSOR_STATE_STALE_SECONDS = 15

    def tearDown(self):
        self.directory.cleanup()

    def _write(self, path, value):
        path.write_text(json.dumps(value), encoding="utf-8")
        return time.time()

    def test_mqtt_topology_is_preferred_when_ready(self):
        mqtt_value = {"topologyReady": True, "sensors": {"E0:E5:BD:A1:C5:8C": {
            "status": "connected", "nodeId": "na1c58c", "ipAddress": "172.16.251.32",
            "boardMac": "E0:E5:BD:A1:C5:8C", "connectedJstyleCount": 1,
            "watches": [{"watchId": "21:02:02:06:9F:7F", "status": "connected"}]
        }}}
        ble_value = {"topologyReady": True, "sensors": {"ESP32-BLE": {
            "status": "connected", "watches": []
        }}}
        now = self._write(MODULE.MQTT_SENSOR_STATUS_FILE, mqtt_value)
        self._write(MODULE.SENSOR_STATUS_FILE, ble_value)
        result = MODULE.sensor_snapshot(now)
        self.assertIn("E0:E5:BD:A1:C5:8C", result)
        self.assertNotIn("ESP32-BLE", result)

    def test_not_ready_mqtt_falls_back_to_ble(self):
        self._write(MODULE.MQTT_SENSOR_STATUS_FILE, {"topologyReady": False, "sensors": {}})
        now = self._write(MODULE.SENSOR_STATUS_FILE, {"topologyReady": True, "sensors": {
            "ESP32-BLE": {"status": "connected", "watches": []}
        }})
        result = MODULE.sensor_snapshot(now)
        self.assertIn("ESP32-BLE", result)


if __name__ == "__main__":
    unittest.main()
