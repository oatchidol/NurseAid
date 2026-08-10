import asyncio
import json
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from nurseaid_ble_gateway import (
    BLE_STALE_THRESHOLD,
    DATA_RECEIVE_TIMEOUT,
    JStyleDeviceHandler,
    NurseAidBLEGateway,
    PHASE_2_TIMEOUT,
    SPO2_SENSOR_SETTLE_SECONDS,
    TOPIC_RSSI,
    VitalsPublisher,
    WEAROS_RECONNECT_COOLDOWN,
    WearOSDeviceHandler,
)


class WearOSAdvertisementSelectionTest(unittest.TestCase):
    LOGICAL_MAC = "2E:1C:B8:CF:AF:06"

    def setUp(self):
        self.gateway = NurseAidBLEGateway()
        self.gateway.device_registry = SimpleNamespace(
            registered_macs={self.LOGICAL_MAC},
            device_metadata={
                self.LOGICAL_MAC: {
                    "device_type": "wearos",
                    "device_no": "WARE_OS",
                }
            },
        )

    @staticmethod
    def device(address, name=None):
        return SimpleNamespace(address=address, name=name)

    @staticmethod
    def advertisement(name=None):
        return SimpleNamespace(
            local_name=name,
            rssi=-60,
            service_uuids=["0000b100-0000-1000-8000-00805f9b34fb"],
            manufacturer_data={},
            service_data={},
        )

    def test_named_identity_is_not_overwritten_by_weaker_advertisement(self):
        preferred_address = "77:42:90:D7:F5:E0"
        self.gateway._detection_callback(
            self.device(preferred_address, "NA-W-AF06"),
            self.advertisement("NA-W-AF06"),
        )
        self.gateway._detection_callback(
            self.device("11:9F:63:AE:91:A8"),
            self.advertisement(),
        )

        selected = self.gateway.discovered[self.LOGICAL_MAC]
        self.assertEqual(preferred_address, selected["ble_address"])
        self.assertEqual("NA-W-AF06", selected["local_name"])

    def test_weaker_advertisement_can_replace_a_stale_identity(self):
        self.gateway._detection_callback(
            self.device("77:42:90:D7:F5:E0", "NA-W-AF06"),
            self.advertisement("NA-W-AF06"),
        )
        self.gateway.discovered[self.LOGICAL_MAC]["seen"] = time.time() - BLE_STALE_THRESHOLD - 1

        replacement_address = "11:9F:63:AE:91:A8"
        self.gateway._detection_callback(
            self.device(replacement_address),
            self.advertisement(),
        )

        self.assertEqual(replacement_address, self.gateway.discovered[self.LOGICAL_MAC]["ble_address"])

    def test_unrelated_device_is_not_matched_by_short_normalized_device_number(self):
        unrelated = SimpleNamespace(
            local_name="realme Buds T310",
            rssi=-70,
            service_uuids=[],
            manufacturer_data={1: bytes.fromhex("01ae020304050607")},
            service_data={},
        )

        self.gateway._detection_callback(
            self.device("98:47:44:B7:FC:6C", "realme Buds T310"),
            unrelated,
        )

        self.assertNotIn(self.LOGICAL_MAC, self.gateway.discovered)

    def test_disconnected_wearos_is_prioritized_before_jstyle_targets(self):
        jstyle_a = "21:02:02:06:9F:20"
        jstyle_b = "21:02:02:05:F9:DD"
        self.gateway.device_registry.device_metadata.update({
            jstyle_a: {"device_type": "jstyle"},
            jstyle_b: {"device_type": "jstyle"},
        })

        ordered = self.gateway._prioritize_connection_targets([
            jstyle_a, jstyle_b, self.LOGICAL_MAC
        ])

        self.assertEqual(self.LOGICAL_MAC, ordered[0])
        self.assertEqual({jstyle_a, jstyle_b}, set(ordered[1:]))

    def test_jstyle_targets_rotate_by_oldest_connection_attempt(self):
        older = "21:02:02:05:F9:DD"
        newer = "21:02:02:06:9F:20"
        self.gateway.device_registry.device_metadata.update({
            older: {"device_type": "jstyle"},
            newer: {"device_type": "jstyle"},
        })
        self.gateway._init_device_state(older)
        self.gateway._init_device_state(newer)
        self.gateway.device_state[older]["last_connection_attempt"] = 10
        self.gateway.device_state[newer]["last_connection_attempt"] = 20

        ordered = self.gateway._prioritize_connection_targets([newer, older])

        self.assertEqual([older, newer], ordered)

    def test_connection_budget_reserves_a_slot_for_disconnected_wearos(self):
        jstyle = "21:02:02:06:9F:20"
        self.gateway.device_registry.device_metadata[jstyle] = {"device_type": "jstyle"}
        self.gateway._init_device_state(jstyle)
        self.gateway.device_state[jstyle]["connected"] = True

        second_jstyle = "21:02:02:05:F9:DD"
        self.gateway.device_registry.device_metadata[second_jstyle] = {"device_type": "jstyle"}
        self.gateway._init_device_state(second_jstyle)

        self.assertFalse(self.gateway._can_start_gatt_connection(second_jstyle))
        self.assertTrue(self.gateway._can_start_gatt_connection(self.LOGICAL_MAC))

    def test_connection_budget_allows_jstyle_when_wearos_occupies_reserved_slot(self):
        self.gateway._init_device_state(self.LOGICAL_MAC)
        self.gateway.device_state[self.LOGICAL_MAC]["connected"] = True
        jstyle = "21:02:02:06:9F:20"
        self.gateway.device_registry.device_metadata[jstyle] = {"device_type": "jstyle"}
        self.gateway._init_device_state(jstyle)

        self.assertTrue(self.gateway._can_start_gatt_connection(jstyle))

    def test_connection_budget_rejects_every_driver_when_full(self):
        self.gateway._init_device_state(self.LOGICAL_MAC)
        self.gateway.device_state[self.LOGICAL_MAC]["connected"] = True
        connected_jstyle = "21:02:02:06:9F:20"
        waiting_jstyle = "21:02:02:05:F9:DD"
        self.gateway.device_registry.device_metadata.update({
            connected_jstyle: {"device_type": "jstyle"},
            waiting_jstyle: {"device_type": "jstyle"},
        })
        self.gateway._init_device_state(connected_jstyle)
        self.gateway._init_device_state(waiting_jstyle)
        self.gateway.device_state[connected_jstyle]["connected"] = True

        self.assertFalse(self.gateway._can_start_gatt_connection(waiting_jstyle))
        self.assertFalse(self.gateway._connection_budget_has_capacity())

    def test_balanced_budget_supports_one_wearos_and_two_jstyle_links(self):
        first_jstyle = "21:02:02:06:9F:20"
        second_jstyle = "21:02:02:05:F9:DD"
        third_jstyle = "21:02:02:05:FF:9A"
        self.gateway.device_registry.device_metadata.update({
            first_jstyle: {"device_type": "jstyle"},
            second_jstyle: {"device_type": "jstyle"},
            third_jstyle: {"device_type": "jstyle"},
        })
        for mac in (self.LOGICAL_MAC, first_jstyle, second_jstyle, third_jstyle):
            self.gateway._init_device_state(mac)
        self.gateway.device_state[self.LOGICAL_MAC]["connected"] = True
        self.gateway.device_state[first_jstyle]["connected"] = True

        with patch("nurseaid_ble_gateway.BLE_MAX_GATT_CONNECTIONS", 3), patch(
            "nurseaid_ble_gateway.BLE_RESERVED_WEAROS_SLOTS", 1
        ):
            self.assertTrue(self.gateway._can_start_gatt_connection(second_jstyle))
            self.gateway.device_state[second_jstyle]["connected"] = True
            self.assertFalse(self.gateway._can_start_gatt_connection(third_jstyle))


class WearOSReconnectTest(unittest.IsolatedAsyncioTestCase):
    MAC = "2E:1C:B8:CF:AF:06"

    async def test_monitor_end_requires_a_fresh_advertisement_and_sets_reconnect_cooldown(self):
        gateway = NurseAidBLEGateway()
        gateway._init_device_state(self.MAC)
        gateway.discovered[self.MAC] = {"device": object(), "seen": time.time()}
        state = gateway.device_state[self.MAC]
        state.update({
            "connected": True,
            "task": object(),
            "cooldown_until": time.time() + 60,
            "monitor_phase": "gatt_setup",
            "watchdog_deadline": time.time() + 60,
        })
        client = SimpleNamespace(is_connected=False)

        with patch("nurseaid_ble_gateway.asyncio.sleep", new=AsyncMock()):
            await gateway._keep_monitoring_wearos(client, self.MAC)

        self.assertFalse(state["connected"])
        self.assertIsNone(state["task"])
        self.assertGreaterEqual(state["cooldown_until"], time.time() + WEAROS_RECONNECT_COOLDOWN - 1)
        self.assertEqual("idle", state["monitor_phase"])
        self.assertNotIn(self.MAC, gateway.discovered)


class ScannerRecoveryTest(unittest.IsolatedAsyncioTestCase):
    async def test_startup_cleanup_releases_links_left_by_a_previous_gateway(self):
        gateway = NurseAidBLEGateway()
        process = SimpleNamespace(communicate=AsyncMock(return_value=(b'', b'')), returncode=0)

        with patch("nurseaid_ble_gateway.asyncio.create_subprocess_shell", new=AsyncMock(return_value=process)), patch.object(
            gateway, "_get_discovery_status", new=AsyncMock(return_value=False)
        ), patch.object(gateway, "_run_shell", new=AsyncMock(return_value=True)) as run_shell, patch(
            "nurseaid_ble_gateway.asyncio.sleep", new=AsyncMock()
        ):
            await gateway._startup_adapter_cleanup()

        cleanup_command = run_shell.await_args.args[0]
        self.assertIn("bluetoothctl devices Connected", cleanup_command)
        self.assertIn("bluetoothctl disconnect", cleanup_command)

    async def test_startup_cleanup_does_not_hard_reset_when_discovery_status_is_unknown(self):
        gateway = NurseAidBLEGateway()
        process = SimpleNamespace(communicate=AsyncMock(return_value=(b'', b'')), returncode=0)

        with patch("nurseaid_ble_gateway.asyncio.create_subprocess_shell", new=AsyncMock(return_value=process)), patch.object(
            gateway, "_get_discovery_status", new=AsyncMock(return_value=None)
        ), patch.object(gateway, "_hard_reset_adapter", new=AsyncMock()) as reset:
            await gateway._startup_adapter_cleanup()

        reset.assert_not_awaited()

    async def test_startup_cleanup_does_not_reset_shared_adapter_during_transient_discovery(self):
        gateway = NurseAidBLEGateway()
        process = SimpleNamespace(communicate=AsyncMock(return_value=(b'', b'')), returncode=0)

        with patch("nurseaid_ble_gateway.asyncio.create_subprocess_shell", new=AsyncMock(return_value=process)), patch.object(
            gateway, "_get_discovery_status", new=AsyncMock(side_effect=[True, False])
        ), patch("nurseaid_ble_gateway.asyncio.sleep", new=AsyncMock()), patch.object(
            gateway, "_hard_reset_adapter", new=AsyncMock()
        ) as reset:
            await gateway._startup_adapter_cleanup()

        reset.assert_not_awaited()

    async def test_unknown_discovery_status_keeps_existing_scanner(self):
        gateway = NurseAidBLEGateway()
        scanner = SimpleNamespace(stop=AsyncMock())
        gateway.scanner = scanner

        with patch.object(gateway, "_get_discovery_status", new=AsyncMock(return_value=None)), patch(
            "nurseaid_ble_gateway.BleakScanner"
        ) as scanner_factory:
            started = await gateway.start_scanner()

        self.assertTrue(started)
        self.assertIs(gateway.scanner, scanner)
        scanner.stop.assert_not_awaited()
        scanner_factory.assert_not_called()

    async def test_start_reconciles_scanner_object_when_bluez_is_not_discovering(self):
        gateway = NurseAidBLEGateway()
        stale_scanner = SimpleNamespace(stop=AsyncMock())
        fresh_scanner = SimpleNamespace(start=AsyncMock())
        gateway.scanner = stale_scanner

        with patch.object(gateway, "_get_discovery_status", new=AsyncMock(return_value=False)), patch.object(
            gateway, "_run_shell", new=AsyncMock(return_value=True)
        ), patch("nurseaid_ble_gateway.BleakScanner", return_value=fresh_scanner):
            started = await gateway.start_scanner()

        self.assertTrue(started)
        stale_scanner.stop.assert_awaited_once()
        fresh_scanner.start.assert_awaited_once()
        self.assertIs(gateway.scanner, fresh_scanner)

    async def test_stop_error_forces_bluez_scan_off_and_clears_reference(self):
        gateway = NurseAidBLEGateway()
        gateway.scanner = SimpleNamespace(stop=AsyncMock(side_effect=RuntimeError("InProgress")))

        with patch.object(gateway, "_get_discovery_status", new=AsyncMock(return_value=False)), patch.object(
            gateway, "_run_shell", new=AsyncMock(return_value=True)
        ) as run_shell:
            await gateway.stop_scanner()

        self.assertIsNone(gateway.scanner)
        run_shell.assert_awaited_once_with(
            "busctl call org.bluez /org/bluez/hci0 org.bluez.Adapter1 StopDiscovery",
            timeout=5.0,
        )

    def test_stale_scanner_requires_no_connections_and_old_advertisements(self):
        gateway = NurseAidBLEGateway()
        now = 1_000.0
        gateway.last_advertisement_timestamp = now - 91
        self.assertTrue(gateway._scanner_data_plane_stale(now))

        gateway._init_device_state("AA:BB:CC:DD:EE:FF")
        gateway.device_state["AA:BB:CC:DD:EE:FF"]["connected"] = True
        self.assertFalse(gateway._scanner_data_plane_stale(now))

    def test_health_does_not_trust_orphaned_discovery_without_advertisements(self):
        gateway = NurseAidBLEGateway()
        gateway.last_advertisement_timestamp = time.time() - 91

        with patch("nurseaid_ble_gateway.BLE_HEALTH_FILE") as health_file:
            gateway._write_health_state(discovering=True)

        payload = json.loads(health_file.with_suffix.return_value.write_text.call_args.args[0])
        self.assertFalse(payload["scannerHealthy"])

    def test_operational_status_contains_only_aggregate_runtime_data(self):
        gateway = NurseAidBLEGateway()
        gateway.device_registry = SimpleNamespace(
            registered_macs={"AA:BB:CC:DD:EE:FF", "11:22:33:44:55:66"}
        )
        gateway.discovered["AA:BB:CC:DD:EE:FF"] = {"seen": time.time()}
        gateway._init_device_state("AA:BB:CC:DD:EE:FF")
        gateway.device_state["AA:BB:CC:DD:EE:FF"]["connected"] = True

        status = gateway._operational_status()

        self.assertEqual(status["registeredDevices"], 2)
        self.assertEqual(status["connectedDevices"], 1)
        self.assertEqual(status["discoveredDevices"], 1)
        self.assertNotIn("AA:BB:CC:DD:EE:FF", json.dumps(status))


class JStyleReliabilityTest(unittest.TestCase):
    MAC = "21:02:02:06:9F:20"

    def setUp(self):
        self.gateway = NurseAidBLEGateway()
        self.gateway.device_registry = SimpleNamespace(
            registered_macs={self.MAC},
            device_metadata={self.MAC: {"device_type": "jstyle", "device_no": "2"}},
        )
        self.gateway._init_device_state(self.MAC)

    def test_wear_state_starts_unknown_until_protocol_confirmation(self):
        self.assertIsNone(self.gateway.device_state[self.MAC]["is_wearing"])

    def test_active_phase_deadline_prevents_premature_watchdog_cancel(self):
        now = 1_000.0
        state = self.gateway.device_state[self.MAC]
        state["connected_time"] = now - DATA_RECEIVE_TIMEOUT - 10
        state["last_data_timestamp"] = now - DATA_RECEIVE_TIMEOUT - 10
        state["watchdog_deadline"] = now + 30

        self.assertFalse(self.gateway._connection_is_stale(state, "jstyle", now))

    def test_watchdog_cancels_after_phase_deadline_and_receive_timeout(self):
        now = 1_000.0
        state = self.gateway.device_state[self.MAC]
        state["connected_time"] = now - DATA_RECEIVE_TIMEOUT - 10
        state["last_data_timestamp"] = now - DATA_RECEIVE_TIMEOUT - 10
        state["watchdog_deadline"] = now - 1

        self.assertTrue(self.gateway._connection_is_stale(state, "jstyle", now))

    def test_spo2_queue_deadline_prevents_watchdog_cancelling_waiter(self):
        now = 1_000.0
        state = self.gateway.device_state[self.MAC]
        state["monitor_phase"] = "spo2_queue"
        state["connected_time"] = now - DATA_RECEIVE_TIMEOUT - 10
        state["last_data_timestamp"] = now - DATA_RECEIVE_TIMEOUT - 10
        state["watchdog_deadline"] = now + 120

        self.assertFalse(self.gateway._connection_is_stale(state, "jstyle", now))

    def test_spo2_queue_timeout_scales_with_registered_jstyle_count(self):
        second = "21:02:02:05:F9:DD"
        self.gateway.device_registry.device_metadata[second] = {"device_type": "jstyle"}

        one_device = PHASE_2_TIMEOUT + SPO2_SENSOR_SETTLE_SECONDS + 2
        self.assertGreaterEqual(self.gateway._spo2_queue_timeout(), one_device * 2)

    def test_phase1_requires_stable_hr_and_temperature_after_minimum_duration(self):
        state = self.gateway.device_state[self.MAC]
        state["phase_hr_samples"] = [72, 73, 71]
        state["phase_temp_samples"] = [36.1, 36.2, 36.1]

        self.assertFalse(self.gateway._phase1_ready(state, 1))
        self.assertTrue(self.gateway._phase1_ready(state, 999))

    def test_phase1_rejects_unstable_sample_window(self):
        state = self.gateway.device_state[self.MAC]
        state["phase_hr_samples"] = [60, 90, 70]
        state["phase_temp_samples"] = [36.1, 36.2, 36.1]

        self.assertFalse(self.gateway._phase1_ready(state, 999))

    def test_retry_backoff_grows_and_is_bounded(self):
        first = self.gateway._retry_backoff(1)
        second = self.gateway._retry_backoff(2)
        much_later = self.gateway._retry_backoff(20)

        self.assertGreater(second, first)
        self.assertGreaterEqual(much_later, second)
        self.assertEqual(much_later, self.gateway._retry_backoff(21))

    def test_monitor_failures_have_an_independent_exponential_counter(self):
        state = self.gateway.device_state[self.MAC]
        state["fail_count"] = 0
        state["monitor_fail_count"] = 2

        self.assertEqual(
            self.gateway._retry_backoff(2),
            self.gateway._retry_backoff(state["monitor_fail_count"]),
        )
        self.assertGreater(
            self.gateway._retry_backoff(state["monitor_fail_count"]),
            self.gateway._retry_backoff(1),
        )

    def test_advertisement_does_not_publish_unconfirmed_clinical_values(self):
        state = self.gateway.device_state[self.MAC]
        state["last_jstyle_vitals"] = {"spo2": 98, "temp": 36.4}
        self.gateway.vitals_publisher = Mock()

        device = SimpleNamespace(address=self.MAC, name="J2208A 069F20")
        advertisement = SimpleNamespace(
            local_name="J2208A 069F20",
            rssi=-60,
            service_uuids=[],
            service_data={},
            manufacturer_data={
                1: bytes.fromhex("2208210202069f200000000000000069013f39002d0000000000")
            },
        )

        self.gateway._detection_callback(device, advertisement)

        self.gateway.vitals_publisher.publish_vitals.assert_not_called()
        self.gateway.vitals_publisher.publish_rssi.assert_called_once_with(
            self.MAC, -60, source="advertisement"
        )

    def test_rssi_payload_has_quality_unit_and_source(self):
        mqtt = Mock()
        publisher = VitalsPublisher(mqtt)

        publisher.publish_rssi(self.MAC, -68, source="advertisement")

        mqtt.publish_json.assert_called_once()
        topic, payload = mqtt.publish_json.call_args.args
        self.assertEqual(TOPIC_RSSI, topic)
        self.assertEqual(-68, payload["value"])
        self.assertEqual("dBm", payload["unit"])
        self.assertEqual("good", payload["quality"])
        self.assertEqual("advertisement", payload["source"])

    def test_rssi_publish_is_rate_limited_per_device(self):
        mqtt = Mock()
        publisher = VitalsPublisher(mqtt)

        publisher.publish_rssi(self.MAC, -68, source="advertisement")
        publisher.publish_rssi(self.MAC, -69, source="advertisement")

        mqtt.publish_json.assert_called_once()

    def test_off_wrist_hr_packet_only_reports_not_wearing(self):
        packet = bytes.fromhex("09000000000000000000000000000000000000000000680100")
        self.assertEqual(
            {"status": 0, "provider": "jstyle", "raw_provider": "jstyle_0x09"},
            JStyleDeviceHandler.parse_vitals(self.MAC, packet),
        )

    def test_worn_hr_packet_uses_fixed_positions(self):
        packet = bytes.fromhex("0900000000000000000000000000000000000000003c69015f")
        parsed = JStyleDeviceHandler.parse_vitals(self.MAC, packet)
        self.assertEqual(1, parsed["status"])
        self.assertEqual(60, parsed["hr"])
        self.assertEqual(36.1, parsed["temp"])

    def test_off_wrist_spo2_packet_does_not_expose_vitals(self):
        packet = bytes.fromhex("28030000000000006801000000000094")
        self.assertEqual(
            {"status": 0, "provider": "jstyle", "raw_provider": "jstyle_0x28"},
            JStyleDeviceHandler.parse_vitals(self.MAC, packet),
        )

        self.gateway.vitals_publisher = Mock()
        self.gateway.device_state[self.MAC]["monitor_phase"] = "spo2"
        self.gateway.device_state[self.MAC]["spo2_ready"] = True
        self.gateway._on_notification(self.MAC, packet)
        self.assertFalse(self.gateway.device_state[self.MAC]["spo2_ready"])
        self.assertTrue(self.gateway.device_state[self.MAC]["spo2_off_wrist_seen"])

    def test_worn_spo2_packet_uses_fixed_positions(self):
        packet = bytes.fromhex("28034f62000000006e015501000000a1")
        parsed = JStyleDeviceHandler.parse_vitals(self.MAC, packet)
        self.assertEqual(1, parsed["status"])
        self.assertEqual(98, parsed["spo2"])
        self.assertEqual(85, parsed["hr"])

    def test_spo2_progress_packet_is_not_exposed_as_a_result(self):
        packet = bytes.fromhex("28034e00000000006e0155010000003e")
        parsed = JStyleDeviceHandler.parse_vitals(self.MAC, packet)
        self.assertEqual(1, parsed["status"])
        self.assertEqual(85, parsed["hr"])
        self.assertNotIn("spo2", parsed)

    def test_spo2_packet_with_bad_checksum_is_rejected(self):
        packet = bytes.fromhex("28034f62000000006e015501000000a2")
        self.assertIsNone(JStyleDeviceHandler.parse_vitals(self.MAC, packet))

    def test_unknown_binary_packet_is_not_guessed_as_clinical_data(self):
        packet = bytes.fromhex("0a683c69010000000000000000000018")
        self.assertIsNone(JStyleDeviceHandler.parse_vitals(self.MAC, packet))

    def test_text_vitals_without_current_wear_status_are_not_published(self):
        self.gateway.device_state[self.MAC]["is_wearing"] = 1
        self.gateway.vitals_publisher = Mock()

        self.gateway._on_notification(self.MAC, b'{"hr":72,"temp":36.5}')

        published = self.gateway.vitals_publisher.publish_vitals.call_args.args[1]
        self.assertNotIn("hr", published)
        self.assertNotIn("temp", published)

    def test_spo2_uses_device_final_result_and_never_publishes_it_raw(self):
        self.gateway.vitals_publisher = Mock()
        self.gateway.device_state[self.MAC]["monitor_phase"] = "spo2"

        for packet in (
            "28034d00000000006e0155010000003d",
            "28034e00000000006e0155010000003e",
            "28034f62000000006e015501000000a1",
        ):
            self.gateway._on_notification(self.MAC, bytes.fromhex(packet))

        published = [call.args[1] for call in self.gateway.vitals_publisher.publish_vitals.call_args_list]
        self.assertTrue(all("spo2" not in payload for payload in published))
        self.assertTrue(self.gateway.device_state[self.MAC]["spo2_ready"])
        self.assertEqual(98, self.gateway.device_state[self.MAC]["last_spo2_value"])

    def test_spo2_round_rejects_motion_from_unstable_heart_rate(self):
        samples = [(96, 70), (96, 73), (97, 90), (96, 72), (96, 71)]
        self.assertIsNone(self.gateway._estimate_jstyle_spo2_round(samples))

    def test_spo2_round_discards_optical_outlier(self):
        samples = [(97, 70), (97, 71), (76, 70), (98, 72), (97, 71)]
        self.assertEqual(97, self.gateway._estimate_jstyle_spo2_round(samples))

    def test_wearos_parser_remains_independent_from_jstyle_filter(self):
        parsed = WearOSDeviceHandler.parse_vitals(
            self.MAC, b'{"hr":72,"spo2":98,"status":1}'
        )
        self.assertEqual(98, parsed["spo2"])

    def test_unverified_jstyle_spo2_is_removed_by_publisher(self):
        mqtt = Mock()
        from nurseaid_ble_gateway import VitalsPublisher
        publisher = VitalsPublisher(mqtt)

        publisher.publish_vitals(self.MAC, {
            "spo2": 99, "status": 1, "provider": "jstyle"
        }, {})

        vitals = next(call.args[1] for call in mqtt.publish_json.call_args_list if call.args[0] == "ble/vitals")
        self.assertIsNone(vitals["spo2"])
        self.assertEqual("unavailable", vitals["spo2_status"])

    def test_verified_jstyle_spo2_is_published(self):
        mqtt = Mock()
        from nurseaid_ble_gateway import VitalsPublisher
        publisher = VitalsPublisher(mqtt)

        publisher.publish_vitals(self.MAC, {
            "spo2": 97, "spo2_quality": "verified", "status": 1, "provider": "jstyle"
        }, {})

        vitals = next(call.args[1] for call in mqtt.publish_json.call_args_list if call.args[0] == "ble/vitals")
        self.assertEqual(97, vitals["spo2"])
        self.assertEqual("verified", vitals["spo2_status"])



class JStyleSpO2CycleTest(unittest.IsolatedAsyncioTestCase):
    MAC = "21:02:02:06:9F:20"

    async def test_spo2_cycle_clears_stale_value_and_reports_timeout(self):
        gateway = NurseAidBLEGateway()
        gateway._init_device_state(self.MAC)
        gateway.device_state[self.MAC]["last_spo2_value"] = 98
        gateway.device_state[self.MAC]["is_wearing"] = 1
        gateway.vitals_publisher = Mock()

        client = SimpleNamespace(
            is_connected=True,
            write_gatt_char=AsyncMock(),
        )

        with patch("nurseaid_ble_gateway.PHASE_2_TIMEOUT", 0), patch(
            "nurseaid_ble_gateway.asyncio.sleep", new=AsyncMock()
        ):
            received = await gateway._phase2_spo2(client, self.MAC)

        self.assertFalse(received)
        self.assertEqual(0, gateway.device_state[self.MAC]["last_spo2_value"])
        gateway.vitals_publisher.publish_spo2_quality.assert_any_call(
            self.MAC, "timeout", {}, samples=0
        )

    async def test_spo2_cycle_starts_and_stops_once_then_publishes_stable_window(self):
        gateway = NurseAidBLEGateway()
        gateway._init_device_state(self.MAC)
        gateway.vitals_publisher = Mock()
        state = gateway.device_state[self.MAC]
        state["is_wearing"] = 1
        client = SimpleNamespace(is_connected=True, write_gatt_char=AsyncMock())

        async def simulated_sleep(_seconds):
            state["last_spo2_value"] = 97
            state["spo2_candidate_count"] = 5
            state["spo2_ready"] = True

        with patch("nurseaid_ble_gateway.asyncio.sleep", new=simulated_sleep):
            received = await gateway._phase2_spo2(client, self.MAC)

        self.assertTrue(received)
        self.assertEqual("verified", state["spo2_quality"])
        self.assertEqual(97, state["last_spo2_value"])
        verified_payload = gateway.vitals_publisher.publish_vitals.call_args.args[1]
        self.assertEqual(97, verified_payload["spo2"])
        self.assertEqual("verified", verified_payload["spo2_quality"])
        frames = [call.args[1] for call in client.write_gatt_char.call_args_list]
        self.assertEqual(3, len(frames))
        self.assertEqual(0x09, frames[0][0])  # HR/Temp stop
        self.assertEqual(0x01, frames[1][2])  # SpO2 start
        self.assertEqual(0x00, frames[2][2])  # SpO2 stop

    async def test_spo2_cycle_ends_early_after_confirmed_off_wrist(self):
        gateway = NurseAidBLEGateway()
        gateway._init_device_state(self.MAC)
        gateway.vitals_publisher = Mock()
        state = gateway.device_state[self.MAC]
        state["is_wearing"] = 1
        client = SimpleNamespace(is_connected=True, write_gatt_char=AsyncMock())
        sleeps = 0

        async def simulated_sleep(_seconds):
            nonlocal sleeps
            sleeps += 1
            state["spo2_off_wrist_seen"] = True
            state["spo2_off_wrist_confirmed"] = True

        with patch("nurseaid_ble_gateway.SPO2_SENSOR_SETTLE_SECONDS", 0), patch(
            "nurseaid_ble_gateway.asyncio.sleep", new=simulated_sleep
        ):
            received = await gateway._phase2_spo2(client, self.MAC)

        self.assertFalse(received)
        self.assertLessEqual(sleeps, 1)
        gateway.vitals_publisher.publish_spo2_quality.assert_any_call(
            self.MAC, "off_wrist", {}, samples=0
        )

    async def test_spo2_cycle_ends_at_no_progress_timeout_before_hard_timeout(self):
        gateway = NurseAidBLEGateway()
        gateway._init_device_state(self.MAC)
        gateway.vitals_publisher = Mock()
        state = gateway.device_state[self.MAC]
        state["is_wearing"] = 1
        client = SimpleNamespace(is_connected=True, write_gatt_char=AsyncMock())
        clock = [1000.0]
        sleeps = 0

        async def simulated_sleep(seconds):
            nonlocal sleeps
            sleeps += 1
            clock[0] += max(float(seconds), 1.0)

        with patch("nurseaid_ble_gateway.SPO2_SENSOR_SETTLE_SECONDS", 0), patch(
            "nurseaid_ble_gateway.SPO2_NO_PROGRESS_TIMEOUT", 2
        ), patch("nurseaid_ble_gateway.PHASE_2_TIMEOUT", 20), patch(
            "nurseaid_ble_gateway.time.time", side_effect=lambda: clock[0]
        ), patch("nurseaid_ble_gateway.asyncio.sleep", new=simulated_sleep):
            received = await gateway._phase2_spo2(client, self.MAC)

        self.assertFalse(received)
        self.assertLess(sleeps, 20)
        gateway.vitals_publisher.publish_spo2_quality.assert_any_call(
            self.MAC, "timeout", {}, samples=0
        )

    async def test_spo2_final_packet_on_timeout_boundary_is_verified(self):
        gateway = NurseAidBLEGateway()
        gateway._init_device_state(self.MAC)
        gateway.vitals_publisher = Mock()
        state = gateway.device_state[self.MAC]
        state["is_wearing"] = 1
        client = SimpleNamespace(is_connected=True, write_gatt_char=AsyncMock())

        async def boundary_sleep(_seconds):
            state["last_spo2_value"] = 97
            state["spo2_samples"] = [(97, 86)]
            state["spo2_candidate_count"] = 1
            state["spo2_ready"] = False

        with patch("nurseaid_ble_gateway.PHASE_2_TIMEOUT", 0), patch(
            "nurseaid_ble_gateway.asyncio.sleep", new=boundary_sleep
        ):
            received = await gateway._phase2_spo2(client, self.MAC)

        self.assertTrue(received)
        self.assertTrue(state["spo2_ready"])
        self.assertEqual("verified", state["spo2_quality"])
        gateway.vitals_publisher.publish_spo2_quality.assert_any_call(
            self.MAC, "verified", {}, value=97, samples=1
        )

    def test_spo2_progress_packets_do_not_consume_warmup_or_become_samples(self):
        gateway = NurseAidBLEGateway()
        gateway._init_device_state(self.MAC)
        gateway.vitals_publisher = Mock()
        gateway.device_registry = SimpleNamespace(device_metadata={self.MAC: {}})
        state = gateway.device_state[self.MAC]
        state["monitor_phase"] = "spo2"
        state["spo2_warmup_remaining"] = 3

        for packet in (
            "28034d00000000006e0155010000003d",
            "28034e00000000006e0155010000003e",
        ):
            gateway._on_notification(self.MAC, bytes.fromhex(packet))

        self.assertEqual([], state["spo2_samples"])
        self.assertEqual(3, state["spo2_warmup_remaining"])


class SLASchedulerPriorityTest(unittest.TestCase):
    """Test SLA-based scheduler priority in _prioritize_connection_targets."""

    WEAROS_MAC = "2E:1C:B8:CF:AF:06"
    JSTYLE_A = "21:02:02:05:F9:DD"
    JSTYLE_B = "21:02:02:06:9F:20"
    JSTYLE_C = "21:02:02:05:FF:9A"

    def setUp(self):
        self.gateway = NurseAidBLEGateway()
        self.gateway.device_registry = SimpleNamespace(
            registered_macs={self.WEAROS_MAC, self.JSTYLE_A, self.JSTYLE_B, self.JSTYLE_C},
            device_metadata={
                self.WEAROS_MAC: {"device_type": "wearos", "device_no": "WARE_OS"},
                self.JSTYLE_A: {"device_type": "jstyle"},
                self.JSTYLE_B: {"device_type": "jstyle"},
                self.JSTYLE_C: {"device_type": "jstyle"},
            },
        )
        for mac in (self.WEAROS_MAC, self.JSTYLE_A, self.JSTYLE_B, self.JSTYLE_C):
            self.gateway._init_device_state(mac)

    def test_wearos_always_first_regardless_of_sla(self):
        """Wear OS should always be prioritized before JStyle, even if JStyle is very stale."""
        now = time.time()
        # JStyle A has very old data (very stale)
        self.gateway.device_state[self.JSTYLE_A]["last_hr_at"] = now - 10000
        # WearOS has no SLA tracking (returns 0 staleness)
        ordered = self.gateway._prioritize_connection_targets(
            [self.JSTYLE_A, self.WEAROS_MAC]
        )
        self.assertEqual(self.WEAROS_MAC, ordered[0])

    def test_staler_jstyle_gets_higher_priority(self):
        """JStyle with older data should come before JStyle with fresh data."""
        now = time.time()
        # A has stale data (10 min ago)
        self.gateway.device_state[self.JSTYLE_A]["last_hr_at"] = now - 600
        self.gateway.device_state[self.JSTYLE_A]["last_spo2_verified_at"] = now - 600
        self.gateway.device_state[self.JSTYLE_A]["last_temp_at"] = now - 600
        # B has fresh data (10 sec ago)
        self.gateway.device_state[self.JSTYLE_B]["last_hr_at"] = now - 10
        self.gateway.device_state[self.JSTYLE_B]["last_spo2_verified_at"] = now - 10
        self.gateway.device_state[self.JSTYLE_B]["last_temp_at"] = now - 10
        # Same connection attempt time
        self.gateway.device_state[self.JSTYLE_A]["last_connection_attempt"] = 100
        self.gateway.device_state[self.JSTYLE_B]["last_connection_attempt"] = 100

        ordered = self.gateway._prioritize_connection_targets(
            [self.JSTYLE_B, self.JSTYLE_A]
        )
        self.assertEqual(self.JSTYLE_A, ordered[0])
        self.assertEqual(self.JSTYLE_B, ordered[1])

    def test_never_connected_jstyle_has_highest_sla_urgency(self):
        """JStyle that has never received data (timestamps=0) should be very urgent."""
        now = time.time()
        # A never got data (defaults to 0)
        # B got fresh data
        self.gateway.device_state[self.JSTYLE_B]["last_hr_at"] = now - 5
        self.gateway.device_state[self.JSTYLE_B]["last_spo2_verified_at"] = now - 5
        self.gateway.device_state[self.JSTYLE_B]["last_temp_at"] = now - 5

        ordered = self.gateway._prioritize_connection_targets(
            [self.JSTYLE_B, self.JSTYLE_A]
        )
        self.assertEqual(self.JSTYLE_A, ordered[0])

    def test_fallback_to_oldest_connection_attempt_when_sla_equal(self):
        """When SLA staleness is equal, older connection attempt goes first."""
        now = time.time()
        # Both have same SLA staleness
        self.gateway.device_state[self.JSTYLE_A]["last_hr_at"] = now - 300
        self.gateway.device_state[self.JSTYLE_B]["last_hr_at"] = now - 300
        self.gateway.device_state[self.JSTYLE_A]["last_spo2_verified_at"] = now - 300
        self.gateway.device_state[self.JSTYLE_B]["last_spo2_verified_at"] = now - 300
        self.gateway.device_state[self.JSTYLE_A]["last_temp_at"] = now - 300
        self.gateway.device_state[self.JSTYLE_B]["last_temp_at"] = now - 300
        # A tried earlier (should go first)
        self.gateway.device_state[self.JSTYLE_A]["last_connection_attempt"] = 10
        self.gateway.device_state[self.JSTYLE_B]["last_connection_attempt"] = 20

        ordered = self.gateway._prioritize_connection_targets(
            [self.JSTYLE_B, self.JSTYLE_A]
        )
        self.assertEqual(self.JSTYLE_A, ordered[0])

    def test_three_jstyle_ordered_by_staleness(self):
        """Three JStyle devices should be ordered from most stale to least stale."""
        now = time.time()
        # C = most stale (20 min)
        self.gateway.device_state[self.JSTYLE_C]["last_hr_at"] = now - 1200
        self.gateway.device_state[self.JSTYLE_C]["last_spo2_verified_at"] = now - 1200
        self.gateway.device_state[self.JSTYLE_C]["last_temp_at"] = now - 1200
        # A = medium stale (5 min)
        self.gateway.device_state[self.JSTYLE_A]["last_hr_at"] = now - 300
        self.gateway.device_state[self.JSTYLE_A]["last_spo2_verified_at"] = now - 300
        self.gateway.device_state[self.JSTYLE_A]["last_temp_at"] = now - 300
        # B = fresh (30 sec)
        self.gateway.device_state[self.JSTYLE_B]["last_hr_at"] = now - 30
        self.gateway.device_state[self.JSTYLE_B]["last_spo2_verified_at"] = now - 30
        self.gateway.device_state[self.JSTYLE_B]["last_temp_at"] = now - 30

        ordered = self.gateway._prioritize_connection_targets(
            [self.JSTYLE_B, self.JSTYLE_A, self.JSTYLE_C]
        )
        self.assertEqual([self.JSTYLE_C, self.JSTYLE_A, self.JSTYLE_B], ordered)

    def test_spo2_staleness_drives_priority_when_hr_is_fresh(self):
        """If HR is fresh but SpO2 is very old, SLA staleness should still be high."""
        now = time.time()
        # A: HR fresh, SpO2 very old
        self.gateway.device_state[self.JSTYLE_A]["last_hr_at"] = now - 5
        self.gateway.device_state[self.JSTYLE_A]["last_spo2_verified_at"] = now - 1800
        self.gateway.device_state[self.JSTYLE_A]["last_temp_at"] = now - 5
        # B: All metrics fresh
        self.gateway.device_state[self.JSTYLE_B]["last_hr_at"] = now - 5
        self.gateway.device_state[self.JSTYLE_B]["last_spo2_verified_at"] = now - 5
        self.gateway.device_state[self.JSTYLE_B]["last_temp_at"] = now - 5

        ordered = self.gateway._prioritize_connection_targets(
            [self.JSTYLE_B, self.JSTYLE_A]
        )
        self.assertEqual(self.JSTYLE_A, ordered[0])


if __name__ == "__main__":
    unittest.main()
