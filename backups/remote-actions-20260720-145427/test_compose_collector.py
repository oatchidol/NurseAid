import importlib.util, json, os, tempfile, unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("collector", Path(__file__).with_name("nurseaid-compose-collector.py"))
collector = importlib.util.module_from_spec(spec); spec.loader.exec_module(collector)

class CollectorTests(unittest.TestCase):
    @patch.object(collector, "command")
    def test_missing_container_is_explicit(self, command):
        command.return_value = ""
        self.assertEqual(collector.inspect_service("mqtt-bridge")["status"], "missing")
        self.assertIn("label=com.docker.compose.service=mqtt-bridge", command.call_args.args)

    @patch.object(collector, "command")
    def test_expected_services_come_from_compose_labels(self, command):
        command.return_value = "postgres\nnurseaid\npostgres\n"
        self.assertEqual(collector.expected_services(), ["nurseaid", "postgres"])
        self.assertIn("label=com.docker.compose.project=nurseaid", command.call_args.args)

    @patch.object(collector, "command")
    def test_unhealthy_details_are_extracted(self, command):
        command.side_effect = ["abc\n", '[{"Name":"/nurseaid-app","RestartCount":2,"State":{"Status":"running","ExitCode":0,"OOMKilled":false,"StartedAt":"now","Health":{"Status":"unhealthy","FailingStreak":3,"Log":[{"Output":"connection refused"}]}}}]']
        value = collector.inspect_service("nurseaid")
        self.assertEqual(value["status"], "unhealthy")
        self.assertEqual(value["failingStreak"], 3)
        self.assertEqual(value["lastHealthOutput"], "connection refused")

    def test_atomic_write_is_valid_json(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(collector, "OUTPUT_FILE", Path(directory) / "status.json"):
                collector.atomic_write({"services": {}})
                self.assertEqual((Path(directory) / "status.json").read_text(), '{"services":{}}')

    @patch.object(collector.os, "chown")
    @patch.object(collector, "command")
    def test_live_log_request_only_uses_allowlisted_compose_service(self, command, _chown):
        session = "123e4567-e89b-42d3-a456-426614174000"
        command.side_effect = ["nurseaid\npostgres\n", "abc123\n", "nurseaid | safe log\n"]
        with tempfile.TemporaryDirectory() as directory:
            spool = Path(directory); request = spool / f"{session}.request.json"
            request.write_text(json.dumps({"service": "nurseaid", "expiresAt": (datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat()}))
            with patch.object(collector, "SPOOL_DIR", spool): collector.process_log_requests()
            self.assertIn("safe log", json.loads((spool / f"{session}.response.json").read_text())["content"])
            self.assertEqual(command.call_args_list[-1].args, ("docker", "logs", "--timestamps", "--since", command.call_args_list[-1].args[-2], "abc123"))

    @patch.object(collector.os, "chown")
    @patch.object(collector, "command")
    def test_live_log_request_rejects_service_outside_compose(self, command, _chown):
        session = "123e4567-e89b-42d3-a456-426614174000"; command.return_value = "nurseaid\n"
        with tempfile.TemporaryDirectory() as directory:
            spool = Path(directory); request = spool / f"{session}.request.json"
            request.write_text(json.dumps({"service": "not-allowed", "expiresAt": (datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat()}))
            with patch.object(collector, "SPOOL_DIR", spool): collector.process_log_requests()
            self.assertFalse((spool / f"{session}.response.json").exists())

    @patch.object(collector.os, "chown")
    @patch.object(collector, "command")
    def test_stale_live_log_spool_files_are_removed(self, command, _chown):
        command.return_value = "nurseaid\n"; now = datetime.now(timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            spool = Path(directory); stale = spool / "old.cursor"; stale.write_text("old")
            timestamp = (now - timedelta(hours=2)).timestamp(); os.utime(stale, (timestamp, timestamp))
            with patch.object(collector, "SPOOL_DIR", spool): collector.process_log_requests(now)
            self.assertFalse(stale.exists())

    @patch.object(collector.os, "chown")
    @patch.object(collector, "wait_for_service", return_value={"status": "healthy", "healthStatus": "healthy"})
    @patch.object(collector, "command")
    def test_restart_action_uses_allowlisted_container_id_without_shell(self, command, _wait, _chown):
        action_id = "123e4567-e89b-42d3-a456-426614174000"
        command.side_effect = ["nurseaid\npostgres\ndevice-agent\ncompose-collector\n", "abc123\n", "abc123\n"]
        with tempfile.TemporaryDirectory() as directory:
            spool = Path(directory); request = spool / f"{action_id}.action-request.json"
            request.write_text(json.dumps({"action": "restart_service", "service": "nurseaid", "expiresAt": (datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat()}))
            with patch.object(collector, "SPOOL_DIR", spool): collector.process_action_requests()
            result = json.loads((spool / f"{action_id}.action-response.json").read_text())
            self.assertEqual(result["status"], "succeeded")
            self.assertIn(("docker", "restart", "abc123"), [call.args for call in command.call_args_list])

    @patch.object(collector.os, "chown")
    @patch.object(collector, "command")
    def test_restart_action_rejects_non_compose_and_device_agent_services(self, command, _chown):
        command.return_value = "nurseaid\ndevice-agent\ncompose-collector\n"
        for service in ("not-allowed", "device-agent", "compose-collector"):
            with self.subTest(service=service), tempfile.TemporaryDirectory() as directory:
                action_id = "123e4567-e89b-42d3-a456-426614174000"; spool = Path(directory)
                (spool / f"{action_id}.action-request.json").write_text(json.dumps({"action": "restart_service", "service": service, "expiresAt": (datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat()}))
                with patch.object(collector, "SPOOL_DIR", spool): collector.process_action_requests()
                result = json.loads((spool / f"{action_id}.action-response.json").read_text())
                self.assertEqual(result["status"], "failed")
        self.assertFalse(any(call.args[:2] == ("docker", "restart") for call in command.call_args_list))

    @patch.object(collector.os, "getloadavg", return_value=(0.1, 0.2, 0.3))
    @patch.object(collector, "host_metrics", return_value={"cpuUsedPercent": 10})
    @patch.object(collector, "inspect_service", return_value={"status": "unhealthy", "restartCount": 2, "lastHealthOutput": "password=must-not-leave"})
    @patch.object(collector, "expected_services", return_value=["nurseaid"])
    def test_diagnostics_excludes_logs_and_configuration(self, _services, _inspect, _metrics, _load):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory); (path / "uptime").write_text("123.4 0")
            with patch.object(collector, "HOST_PROC_PATH", path): value = collector.diagnostics()
        self.assertEqual(value["services"]["nurseaid"]["restartCount"], 2)
        self.assertNotIn("lastHealthOutput", value["services"]["nurseaid"])

if __name__ == "__main__": unittest.main()