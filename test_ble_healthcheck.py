import json
import tempfile
import unittest
from pathlib import Path

from ble_healthcheck import is_healthy


class BLEHealthcheckTest(unittest.TestCase):
    def state_file(self, payload):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "health.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_adapter_flag_cannot_hide_a_stale_scanner_data_plane(self):
        path = self.state_file({
            "controllerHeartbeat": 1000,
            "scannerHealthy": False,
            "status": "unhealthy",
            "adapters": {"hci0": {"healthy": True}},
        })
        self.assertFalse(is_healthy(path, 45, now=1010))

    def test_fresh_heartbeat_and_scanner_data_plane_are_healthy(self):
        path = self.state_file({
            "controllerHeartbeat": 1000,
            "scannerHealthy": True,
            "status": "healthy-degraded",
        })
        self.assertTrue(is_healthy(path, 45, now=1010))

    def test_stale_controller_heartbeat_is_unhealthy(self):
        path = self.state_file({
            "controllerHeartbeat": 1000,
            "scannerHealthy": True,
            "status": "healthy-dual",
        })
        self.assertFalse(is_healthy(path, 45, now=1046))


if __name__ == "__main__":
    unittest.main()