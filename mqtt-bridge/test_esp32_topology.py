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

BOARD_A = "E0:E5:BD:A1:C5:8C"
BOARD_B = "AA:BB:CC:DD:EE:01"
WATCH_W = "21:02:02:06:9F:7F"
WATCH_X = "EC:35:0D:31:14:F6"


def inventory(node_id, board_mac, ip, devices):
    return {"node_id": node_id, "mac": board_mac, "ip": ip, "devices": list(devices), "count": len(devices)}


def watch_ids(snapshot, board_mac):
    return [watch["watchId"] for watch in snapshot["sensors"][board_mac]["watches"]]


class CrossNodeDedupeTests(unittest.TestCase):
    """A JStyle watch can only be connected to one ESP32 at a time, so the most
    recent board to report it owns it and every earlier claim is dropped."""

    def _registry(self, directory):
        return Esp32TopologyRegistry(Path(directory) / "mqtt-sensors.json", stale_seconds=90, settle_seconds=1)

    def test_latest_report_wins_strips_watch_from_the_earlier_board(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = self._registry(directory)
            registry.apply(inventory("na1c58c", BOARD_A, "172.16.251.32", [WATCH_W]), now_monotonic=100)
            registry.apply(inventory("node2", BOARD_B, "172.16.251.33", [WATCH_W]), now_monotonic=110)
            snapshot = registry.snapshot(now_monotonic=120)
            self.assertEqual(watch_ids(snapshot, BOARD_A), [])
            self.assertEqual(watch_ids(snapshot, BOARD_B), [WATCH_W])
            self.assertEqual(snapshot["sensors"][BOARD_A]["connectedJstyleCount"], 0)
            self.assertEqual(snapshot["sensors"][BOARD_B]["connectedJstyleCount"], 1)

    def test_unrelated_watches_on_the_losing_board_are_kept(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = self._registry(directory)
            registry.apply(inventory("na1c58c", BOARD_A, "172.16.251.32", [WATCH_W, WATCH_X]), now_monotonic=100)
            registry.apply(inventory("node2", BOARD_B, "172.16.251.33", [WATCH_W]), now_monotonic=110)
            snapshot = registry.snapshot(now_monotonic=120)
            self.assertEqual(watch_ids(snapshot, BOARD_A), [WATCH_X])
            self.assertEqual(watch_ids(snapshot, BOARD_B), [WATCH_W])

    def test_a_board_reclaims_a_watch_when_it_reports_again(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = self._registry(directory)
            registry.apply(inventory("na1c58c", BOARD_A, "172.16.251.32", [WATCH_W, WATCH_X]), now_monotonic=100)
            registry.apply(inventory("node2", BOARD_B, "172.16.251.33", [WATCH_W]), now_monotonic=110)
            registry.apply(inventory("na1c58c", BOARD_A, "172.16.251.32", [WATCH_W, WATCH_X]), now_monotonic=120)
            snapshot = registry.snapshot(now_monotonic=130)
            self.assertEqual(watch_ids(snapshot, BOARD_A), [WATCH_W, WATCH_X])
            self.assertEqual(watch_ids(snapshot, BOARD_B), [])

    def test_a_board_reporting_an_empty_list_does_not_strip_other_boards(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = self._registry(directory)
            registry.apply(inventory("na1c58c", BOARD_A, "172.16.251.32", [WATCH_W]), now_monotonic=100)
            registry.apply(inventory("node2", BOARD_B, "172.16.251.33", []), now_monotonic=110)
            snapshot = registry.snapshot(now_monotonic=120)
            self.assertEqual(watch_ids(snapshot, BOARD_A), [WATCH_W])
            self.assertEqual(watch_ids(snapshot, BOARD_B), [])

    def _write_conflicting_cache(self, path, age_a, age_b):
        path.write_text(json.dumps({
            "topologyReady": True,
            "sensors": {
                BOARD_A: {
                    "nodeId": "na1c58c",
                    "boardMac": BOARD_A,
                    "ipAddress": "172.16.251.32",
                    "lastSeenAgeSeconds": age_a,
                    "watches": [{"watchId": WATCH_W, "status": "disconnected"}],
                },
                BOARD_B: {
                    "nodeId": "node2",
                    "boardMac": BOARD_B,
                    "ipAddress": "172.16.251.33",
                    "lastSeenAgeSeconds": age_b,
                    "watches": [{"watchId": WATCH_W, "status": "disconnected"}],
                },
            },
        }), encoding="utf-8")

    def test_cache_load_gives_a_contested_watch_to_the_freshest_board(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mqtt-sensors.json"
            self._write_conflicting_cache(path, age_a=5, age_b=600)
            registry = Esp32TopologyRegistry(path, stale_seconds=90, settle_seconds=1)
            snapshot = registry.snapshot(now_monotonic=10)
            self.assertEqual(watch_ids(snapshot, BOARD_A), [WATCH_W])
            self.assertEqual(watch_ids(snapshot, BOARD_B), [])

    def test_cache_load_never_leaves_a_watch_under_two_boards(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mqtt-sensors.json"
            self._write_conflicting_cache(path, age_a=None, age_b=None)
            registry = Esp32TopologyRegistry(path, stale_seconds=90, settle_seconds=1)
            snapshot = registry.snapshot(now_monotonic=10)
            owners = [mac for mac in (BOARD_A, BOARD_B) if WATCH_W in watch_ids(snapshot, mac)]
            self.assertEqual(len(owners), 1, "a watch must belong to exactly one board")

    def test_cache_load_conflict_resolution_is_deterministic(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mqtt-sensors.json"
            self._write_conflicting_cache(path, age_a=None, age_b=None)
            first = Esp32TopologyRegistry(path, stale_seconds=90, settle_seconds=1).snapshot(now_monotonic=10)
            second = Esp32TopologyRegistry(path, stale_seconds=90, settle_seconds=1).snapshot(now_monotonic=10)
            self.assertEqual(watch_ids(first, BOARD_A), watch_ids(second, BOARD_A))
            self.assertEqual(watch_ids(first, BOARD_B), watch_ids(second, BOARD_B))


if __name__ == "__main__":
    unittest.main()
