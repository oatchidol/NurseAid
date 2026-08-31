import asyncio
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("nurseaid-ble-gateway.py")
SPEC = importlib.util.spec_from_file_location("nurseaid_ble_gateway", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakeBleakClient:
    """Minimal Bleak-compatible fake used to exercise connection workers in CI."""

    payloads_by_address = {}
    fail_addresses = set()

    def __init__(self, address, timeout=15):
        self.address = address
        self.timeout = timeout
        self.is_connected = False

    async def connect(self):
        if self.address in self.fail_addresses:
            raise RuntimeError("simulated connection failure")
        self.is_connected = True

    async def start_notify(self, _characteristic, callback):
        for payload in self.payloads_by_address.get(self.address, []):
            callback(None, json.dumps(payload).encode("utf-8"))
        self.is_connected = False

    async def disconnect(self):
        self.is_connected = False

    async def write_gatt_char(self, _characteristic, _payload, response=True):
        return None


class ConfigTests(unittest.TestCase):
    def test_disabled_empty_config_is_valid(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text('{"enabled":false,"sensors":[]}', encoding="utf-8")
            enabled, _reconnect, _reboot, sensors = MODULE.load_config(path)
            self.assertFalse(enabled)
            self.assertEqual(sensors, ())

    def test_enabled_requires_sensor(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text('{"enabled":true,"sensors":[]}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "at least one"):
                MODULE.load_config(path)


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def test_valid_nested_telemetry_replaces_watch_list(self):
        sensor = MODULE.SensorConfig("AA:BB:CC:DD:EE:01", "AA:BB:CC:DD:EE:01", "notify", "", b"")
        gateway = MODULE.Gateway(True, 60, 45, (sensor,))
        await gateway.apply_telemetry(sensor.sensor_id, {
            "schemaVersion": 1,
            "sensorId": "aa-bb-cc-dd-ee-01",
            "firmwareVersion": "1.2.0",
            "watches": [
                {"watchId": "A12", "status": "connected", "batteryPercent": 82,
                 "rssiDbm": -58, "packetLossPercent": 0.4, "lastPacketAgeSeconds": 8},
                {"watchId": "B07", "status": "disconnected"},
            ],
        })
        state = gateway.states[sensor.sensor_id]
        self.assertEqual(state.status, "connected")
        self.assertEqual(state.firmware_version, "1.2.0")
        self.assertEqual(set(state.watches), {"A12", "B07"})
        self.assertEqual(state.watches["A12"].snapshot(state.watches["A12"].observed_monotonic)["lastPacketAgeSeconds"], 8)

    async def test_malformed_watches_does_not_clear_last_valid_state(self):
        sensor = MODULE.SensorConfig("ESP32-A", "AA:BB:CC:DD:EE:01", "notify", "", b"")
        gateway = MODULE.Gateway(True, 60, 45, (sensor,))
        await gateway.apply_telemetry("ESP32-A", {
            "schemaVersion": 1,
            "watches": [{"watchId": "A12", "status": "connected"}],
        })
        with self.assertRaisesRegex(ValueError, "array"):
            await gateway.apply_telemetry("ESP32-A", {"schemaVersion": 1, "watches": {}})
        self.assertEqual(set(gateway.states["ESP32-A"].watches), {"A12"})

    async def test_malformed_child_rejects_entire_full_snapshot(self):
        sensor = MODULE.SensorConfig("ESP32-A", "AA:BB:CC:DD:EE:01", "notify", "", b"")
        gateway = MODULE.Gateway(True, 60, 45, (sensor,))
        await gateway.apply_telemetry("ESP32-A", {
            "schemaVersion": 1,
            "watches": [
                {"watchId": "A12", "status": "connected"},
                {"watchId": "B07", "status": "connected"},
            ],
        })

        with self.assertRaisesRegex(ValueError, "must be an object"):
            await gateway.apply_telemetry("ESP32-A", {
                "schemaVersion": 1,
                "watches": [{"watchId": "A12", "status": "connected"}, "bad-child"],
            })

        self.assertEqual(set(gateway.states["ESP32-A"].watches), {"A12", "B07"})

    async def test_invalid_numeric_value_rejects_frame_without_mutating_state(self):
        sensor = MODULE.SensorConfig("ESP32-A", "AA:BB:CC:DD:EE:01", "notify", "", b"")
        gateway = MODULE.Gateway(True, 60, 45, (sensor,))
        await gateway.apply_telemetry("ESP32-A", {
            "schemaVersion": 1,
            "watches": [{"watchId": "A12", "status": "connected", "batteryPercent": 82}],
        })

        with self.assertRaisesRegex(ValueError, "batteryPercent out of range"):
            await gateway.apply_telemetry("ESP32-A", {
                "schemaVersion": 1,
                "watches": [{"watchId": "A12", "status": "connected", "batteryPercent": 101}],
            })

        self.assertEqual(gateway.states["ESP32-A"].watches["A12"].battery_percent, 82)

    async def test_confirmed_inventory_contract_tracks_board_and_connected_jstyle_macs(self):
        sensor = MODULE.SensorConfig("ESP32-A", "AA:BB:CC:DD:EE:01", "notify", "", b"")
        gateway = MODULE.Gateway(True, 60, 45, (sensor,))

        await gateway.apply_telemetry("ESP32-A", {
            "schemaVersion": 1,
            "node_id": "NODE_01",
            "ip": "192.168.1.100",
            "mac": "84:F7:03:AE:02:94",
            "jstyle_count": 2,
            "jstyle_macs": ["10:20:30:40:50:60", "AA-BB-CC-DD-EE-FF"],
        })

        state = gateway.states["ESP32-A"]
        self.assertEqual(state.node_id, "NODE_01")
        self.assertEqual(state.ip_address, "192.168.1.100")
        self.assertEqual(state.board_mac, "84:F7:03:AE:02:94")
        self.assertEqual(set(state.watches), {"10:20:30:40:50:60", "AA:BB:CC:DD:EE:FF"})
        self.assertTrue(all(watch.status == "connected" for watch in state.watches.values()))

    async def test_inventory_count_mismatch_rejects_entire_frame(self):
        sensor = MODULE.SensorConfig("ESP32-A", "AA:BB:CC:DD:EE:01", "notify", "", b"")
        gateway = MODULE.Gateway(True, 60, 45, (sensor,))

        with self.assertRaisesRegex(ValueError, "does not match"):
            await gateway.apply_telemetry("ESP32-A", {
                "schemaVersion": 1,
                "node_id": "NODE_01",
                "ip": "192.168.1.100",
                "mac": "84:F7:03:AE:02:94",
                "jstyle_count": 2,
                "jstyle_macs": ["10:20:30:40:50:60"],
            })

        self.assertEqual(gateway.states["ESP32-A"].watches, {})

    async def test_topology_ready_only_after_every_managed_sensor_is_observed(self):
        sensors = (
            MODULE.SensorConfig("ESP32-A", "AA:BB:CC:DD:EE:01", "notify", "", b""),
            MODULE.SensorConfig("ESP32-B", "AA:BB:CC:DD:EE:02", "notify", "", b""),
        )
        gateway = MODULE.Gateway(True, 60, 45, sensors)
        self.assertFalse(gateway.topology_ready)

        await gateway.mark_connected("ESP32-A", object())
        self.assertFalse(gateway.topology_ready)

        await gateway.mark_disconnected("ESP32-B")
        self.assertTrue(gateway.topology_ready)

    async def test_fake_transport_three_esp32_seven_watches_fixture(self):
        sensors = (
            MODULE.SensorConfig("ESP32-A", "FA:KE:00:00:00:01", "notify", "", b""),
            MODULE.SensorConfig("ESP32-B", "FA:KE:00:00:00:02", "notify", "", b""),
            MODULE.SensorConfig("ESP32-C", "FA:KE:00:00:00:03", "notify", "", b""),
        )
        FakeBleakClient.fail_addresses = set()
        FakeBleakClient.payloads_by_address = {
            "FA:KE:00:00:00:01": [{
                "schemaVersion": 1, "sensorId": "ESP32-A", "firmwareVersion": "1.2.0",
                "watches": [
                    {"watchId": "A12", "status": "connected", "batteryPercent": 82, "rssiDbm": -58, "packetLossPercent": 0.4, "lastPacketAgeSeconds": 8},
                    {"watchId": "B07", "status": "connected", "batteryPercent": 41, "rssiDbm": -86, "packetLossPercent": 10.4, "lastPacketAgeSeconds": 18},
                    {"watchId": "C03", "status": "disconnected", "lastPacketAgeSeconds": 960},
                ],
            }],
            "FA:KE:00:00:00:02": [{
                "schemaVersion": 1, "sensorId": "ESP32-B", "firmwareVersion": "1.2.0",
                "watches": [
                    {"watchId": "D14", "status": "connected", "batteryPercent": 76, "rssiDbm": -61, "packetLossPercent": 0.8, "lastPacketAgeSeconds": 7},
                    {"watchId": "E09", "status": "connected", "batteryPercent": 64, "rssiDbm": -63, "packetLossPercent": 0.5, "lastPacketAgeSeconds": 9},
                ],
            }],
            "FA:KE:00:00:00:03": [{
                "schemaVersion": 1, "sensorId": "ESP32-C", "firmwareVersion": "1.2.1",
                "watches": [
                    {"watchId": "F03", "status": "connected", "batteryPercent": 91, "rssiDbm": -55, "packetLossPercent": 0.1, "lastPacketAgeSeconds": 6},
                    {"watchId": "G18", "status": "connected", "batteryPercent": 69, "rssiDbm": -66, "packetLossPercent": 1.2, "lastPacketAgeSeconds": 10},
                ],
            }],
        }

        gateway = MODULE.Gateway(True, 60, 45, sensors, client_factory=FakeBleakClient)
        tasks = [asyncio.create_task(gateway.sensor_worker(sensor)) for sensor in sensors]
        try:
            for _ in range(100):
                if all(state.telemetry_generation > 0 for state in gateway.states.values()):
                    break
                await asyncio.sleep(0.01)

            self.assertTrue(gateway.topology_ready)
            self.assertTrue(all(state.status == "connected" for state in gateway.states.values()))
            watches = [watch for state in gateway.states.values() for watch in state.watches.values()]
            self.assertEqual(len(watches), 7)
            self.assertEqual(sum(watch.status == "connected" for watch in watches), 6)
            self.assertEqual(gateway.states["ESP32-A"].watches["B07"].rssi_dbm, -86)
            self.assertEqual(gateway.states["ESP32-A"].watches["B07"].packet_loss_percent, 10.4)
            self.assertEqual(gateway.states["ESP32-A"].watches["C03"].status, "disconnected")
        finally:
            gateway.stop.set()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == "__main__":
    unittest.main()
