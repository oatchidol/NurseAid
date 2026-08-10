import importlib.util
import pathlib
import tempfile
import unittest
import stat
import json
from unittest import mock

ROOT = pathlib.Path(__file__).parent

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

agent = load("nurseaid_agent", "nurseaid_agent.py")
collector_path = ROOT / "nurseaid-compose-collector.py"
if not collector_path.exists(): collector_path = ROOT.parent / "ops" / "nurseaid-compose-collector.py"
spec = importlib.util.spec_from_file_location("nurseaid_collector", collector_path)
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)

class AgentMetricsTests(unittest.TestCase):
    def test_cpu_usage_uses_tick_delta(self):
        before = "cpu  100 0 50 850 0 0 0 0 0 0\n"
        after = "cpu  140 0 60 900 0 0 0 0 0 0\n"
        self.assertEqual(agent.cpu_used_percent(before, after), 50.0)

    def test_cpu_usage_rejects_invalid_or_reversed_samples(self):
        self.assertIsNone(agent.cpu_used_percent("missing", "missing"))
        self.assertIsNone(agent.cpu_used_percent("cpu 10 0 0 90", "cpu 5 0 0 80"))

    def test_filesystem_metrics_use_available_blocks(self):
        usage = mock.Mock(f_blocks=1000, f_bavail=100, f_frsize=4096)
        with mock.patch.object(collector.os, "statvfs", return_value=usage):
            self.assertEqual(collector.filesystem_metrics("/"), {
                "diskUsedPercent": 90.0,
                "diskTotalBytes": 4096000,
                "diskAvailableBytes": 409600,
            })

    def test_wait_for_service_returns_after_healthcheck_recovers(self):
        states = [
            {"status": "unhealthy", "containerState": "running", "healthStatus": "starting"},
            {"status": "healthy", "containerState": "running", "healthStatus": "healthy"},
        ]
        with mock.patch.object(collector, "inspect_service", side_effect=states), mock.patch.object(collector.time, "sleep"):
            self.assertEqual(collector.wait_for_service("mqtt-bridge", timeout=10)["status"], "healthy")

    def test_wait_for_service_stops_when_container_exits(self):
        stopped = {"status": "unhealthy", "containerState": "exited", "reason": "container exited"}
        with mock.patch.object(collector, "inspect_service", return_value=stopped):
            self.assertEqual(collector.wait_for_service("mqtt-bridge"), stopped)

    def test_collector_cpu_parser_uses_idle_and_iowait(self):
        self.assertEqual(collector.parse_cpu_times("cpu 100 2 3 400 20 1 2 3 0 0"), (531, 420))

    def test_compose_status_preserves_real_collector_runtime(self):
        now = collector.datetime.now(collector.timezone.utc)
        payload = {"collectedAt": now.isoformat(), "services": {"compose-collector": {"status": "healthy", "containerState": "running"}}}
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "status.json"
            path.write_text(__import__("json").dumps(payload))
            with mock.patch.object(agent, "COMPOSE_STATUS_FILE", path): value = agent.compose_status(now)
        self.assertEqual(value["compose-collector"]["containerState"], "running")
        self.assertEqual(value["compose-collector"]["status"], "healthy")

    def test_spool_requests_are_group_readable_for_hardened_collector(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "request.json"
            agent.atomic_spool_json(path, {"ok": True})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o660)

    def test_upload_log_response_sends_idle_state_once_and_removes_response(self):
        credential = {"deviceId": "NA-A1B2C3D4", "credential": "secret"}
        with tempfile.TemporaryDirectory() as directory:
            response = pathlib.Path(directory) / "session.response.json"
            response.write_text(json.dumps({"state": "idle", "content": ""}))
            with mock.patch.object(agent, "request_json", return_value={"accepted": True}) as request:
                state = agent.upload_log_response(credential, "123e4567-e89b-42d3-a456-426614174000", response)
            self.assertEqual(state, "idle")
            self.assertEqual(request.call_args.args[1]["state"], "idle")
            self.assertFalse(response.exists())

    def test_upload_log_response_does_not_repeat_idle_acknowledgement(self):
        credential = {"deviceId": "NA-A1B2C3D4", "credential": "secret"}
        with tempfile.TemporaryDirectory() as directory:
            response = pathlib.Path(directory) / "session.response.json"
            response.write_text(json.dumps({"state": "idle", "content": ""}))
            with mock.patch.object(agent, "request_json") as request:
                state = agent.upload_log_response(credential, "123e4567-e89b-42d3-a456-426614174000", response, "idle")
            self.assertEqual(state, "idle")
            request.assert_not_called()
            self.assertFalse(response.exists())

if __name__ == "__main__":
    unittest.main()