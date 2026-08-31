import json
import tempfile
import unittest
from pathlib import Path

from esp32_topology import Esp32TopologyRegistry, parse_inventory


REAL_PAYLOAD = {
    "node_id": "na1c58c",
    "mac": "E0:E5:BD:A1:C5:8C",
    "ip": "172.16.251.32",
    "devices": ["21:02:02:06:9F:7F"],
    "count": 1,
    "time": "2026-08-28 14:30:54",
    "uuid": "95cd0179-45b5-4f11-886e-4eb1686343c3",
}


class ParseInventoryTests(unittest.TestCase):
    def test_real_public_topic_payload(self):
        value = parse_inventory(REAL_PAYLOAD)
        self.assertEqual(value["nodeId"], "na1c58c")
        self.assertEqual(value["boardMac"], "E0:E5:BD:A1:C5:8C")
        self.assertEqual(value["ipAddress"], "172.16.251.32")
        self.assertEqual(value["devices"], ["21:02:02:06:9F:7F"])

    def test_count_mismatch_is_rejected(self):
        payload = {**REAL_PAYLOAD, "count": 2}
        with self.assertRaisesRegex(ValueError, "count does not match"):
            parse_inventory(payload)

    def test_duplicate_device_mac_is_rejected(self):
        payload = {**REAL_PAYLOAD, "devices": ["21:02:02:06:9F:7F", "21-02-02-06-9f-7f"], "count": 2}
        with self.assertRaisesRegex(ValueError, "duplicate"):
            parse_inventory(payload)


class RegistryTests(unittest.TestCase):
    def test_first_install_waits_for_settle_before_authoritative(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = Esp32TopologyRegistry(Path(directory) / "mqtt-sensors.json", stale_seconds=90, settle_seconds=30)
            registry.apply(REAL_PAYLOAD, now_monotonic=100)
            self.assertFalse(registry.snapshot(now_monotonic=120)["topologyReady"])
            snapshot = registry.snapshot(now_monotonic=131)
            self.assertTrue(snapshot["topologyReady"])
            board = snapshot["sensors"]["E0:E5:BD:A1:C5:8C"]
            self.assertEqual(board["connectedJstyleCount"], 1)
            self.assertEqual(board["watches"][0]["watchId"], "21:02:02:06:9F:7F")

    def test_stale_board_is_retained_but_disconnected(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = Esp32TopologyRegistry(Path(directory) / "mqtt-sensors.json", stale_seconds=90, settle_seconds=1)
            registry.apply(REAL_PAYLOAD, now_monotonic=100)
            snapshot = registry.snapshot(now_monotonic=191)
            board = snapshot["sensors"]["E0:E5:BD:A1:C5:8C"]
            self.assertEqual(board["status"], "disconnected")
            self.assertEqual(board["connectedJstyleCount"], 0)
            self.assertEqual(board["watches"][0]["status"], "disconnected")

    def test_cache_preserves_unseen_board_until_reconciled(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mqtt-sensors.json"
            path.write_text(json.dumps({
                "topologyReady": True,
                "sensors": {
                    "E0:E5:BD:A1:C5:8C": {
                        "nodeId": "na1c58c",
                        "boardMac": "E0:E5:BD:A1:C5:8C",
                        "ipAddress": "172.16.251.32",
                        "watches": [{"watchId": "21:02:02:06:9F:7F", "status": "connected"}],
                    },
                    "AA:BB:CC:DD:EE:01": {
                        "nodeId": "node2",
                        "boardMac": "AA:BB:CC:DD:EE:01",
                        "ipAddress": "172.16.251.33",
                        "watches": [],
                    },
                },
            }), encoding="utf-8")
            registry = Esp32TopologyRegistry(path, stale_seconds=90, settle_seconds=30)
            registry.apply(REAL_PAYLOAD, now_monotonic=100)
            self.assertFalse(registry.snapshot(now_monotonic=110)["topologyReady"])
            settled = registry.snapshot(now_monotonic=131)
            self.assertTrue(settled["topologyReady"])
            self.assertIn("AA:BB:CC:DD:EE:01", settled["sensors"])
            self.assertEqual(settled["sensors"]["AA:BB:CC:DD:EE:01"]["status"], "disconnected")


if __name__ == "__main__":
    unittest.main()
