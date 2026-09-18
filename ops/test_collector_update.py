import importlib.util
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("nurseaid-compose-collector.py")
SPEC = importlib.util.spec_from_file_location("nurseaid_compose_collector", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ApplyUpdateVersionTests(unittest.TestCase):
    def _repo_command(self, old_sha, new_sha):
        def run(*args, **kwargs):
            if args[:3] == ("git", "status", "--porcelain"):
                return ""
            if args[:3] == ("git", "rev-parse", "HEAD"):
                run.rev_count += 1
                return (old_sha if run.rev_count == 1 else new_sha) + "\n"
            return ""
        run.rev_count = 0
        return run

    def _common_patches(self, old_sha, new_sha):
        return (
            mock.patch.object(MODULE, "acquire_apply_update_lock"),
            mock.patch.object(MODULE, "release_apply_update_lock"),
            mock.patch.object(MODULE, "detect_host_lan_ip", return_value=None),
            mock.patch.object(MODULE, "container_ids", return_value=["cid"]),
            mock.patch.object(MODULE, "repo_command", side_effect=self._repo_command(old_sha, new_sha)),
            mock.patch.object(MODULE, "command", return_value="sha256:old-image\n"),
            mock.patch.object(MODULE, "append_apply_update_history"),
            mock.patch.object(MODULE, "report_phase"),
        )

    def test_same_sha_but_stale_runtime_rebuilds_container(self):
        patches = self._common_patches("abc123", "abc123")
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7], \
             mock.patch.object(MODULE, "read_app_version", return_value="2.23.1"), \
             mock.patch.object(MODULE, "running_app_version", side_effect=["2.22.0", "2.23.1"]), \
             mock.patch.object(MODULE, "compose_command") as compose, \
             mock.patch.object(MODULE, "wait_for_service", return_value={"status": "healthy", "containerState": "running"}):
            result = MODULE.run_apply_update("00000000-0000-4000-8000-000000000000")

        self.assertTrue(result["healthy"])
        self.assertEqual(result["version"], "2.23.1")
        self.assertIn("stale", result["message"])
        compose.assert_any_call("build", "nurseaid", timeout=600)
        compose.assert_any_call("up", "-d", "nurseaid", timeout=120)

    def test_same_sha_and_matching_runtime_is_already_up_to_date(self):
        patches = self._common_patches("abc123", "abc123")
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7], \
             mock.patch.object(MODULE, "read_app_version", return_value="2.23.1"), \
             mock.patch.object(MODULE, "running_app_version", return_value="2.23.1"), \
             mock.patch.object(MODULE, "compose_command") as compose:
            result = MODULE.run_apply_update("00000000-0000-4000-8000-000000000000")

        self.assertTrue(result["healthy"])
        self.assertEqual(result["message"], "already up to date")
        compose.assert_not_called()

    def test_healthy_container_with_wrong_version_rolls_back(self):
        patches = self._common_patches("abc123", "def456")
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7], \
             mock.patch.object(MODULE, "read_app_version", return_value="2.23.1"), \
             mock.patch.object(MODULE, "running_app_version", side_effect=["2.22.0", "2.22.0"]), \
             mock.patch.object(MODULE, "compose_command") as compose, \
             mock.patch.object(MODULE, "wait_for_service", side_effect=[
                 {"status": "healthy", "containerState": "running"},
                 {"status": "healthy", "containerState": "running"},
             ]):
            result = MODULE.run_apply_update("00000000-0000-4000-8000-000000000000")

        self.assertFalse(result["healthy"])
        self.assertTrue(result["rolledBack"])
        self.assertTrue(result["rollbackHealthy"])
        self.assertIn("version verification failed", result["reason"])
        compose.assert_any_call("build", "nurseaid", timeout=600)
        self.assertGreaterEqual(compose.call_count, 3)


if __name__ == "__main__":
    unittest.main()
