import asyncio
import json
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from nurseaid_ble_gateway import (
    BLE_STALE_THRESHOLD,
    DATA_RECEIVE_TIMEOUT,
    DeviceRegistry,
    JStyleDeviceHandler,
    JSTYLE_OFF_WRIST_CONFIRMATIONS,
    JSTYLE_OFF_WRIST_CONFIRMATION_WINDOW,
    JSTYLE_OFF_WRIST_MIN_CONFIRMATION_SECONDS,
    JSTYLE_OFF_WRIST_PROBE_INTERVAL,
    JSTYLE_OFF_WRIST_SUSPECT_RETRY,
    NurseAidBLEGateway,
    PHASE_2_TIMEOUT,
    SPO2_SENSOR_SETTLE_SECONDS,
    TOPIC_RSSI,
    VitalsPublisher,
    WEAROS_RECONNECT_COOLDOWN,
    WearOSDeviceHandler,
)
from ble_adapter_manager import AdapterRuntime


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
        self.gateway.device_registry.registered_macs.add(jstyle)
        self.gateway.device_registry.device_metadata[jstyle] = {"device_type": "jstyle"}
        self.gateway._init_device_state(jstyle)
        self.gateway.device_state[jstyle]["connected"] = True

        second_jstyle = "21:02:02:05:F9:DD"
        self.gateway.device_registry.registered_macs.add(second_jstyle)
        self.gateway.device_registry.device_metadata[second_jstyle] = {"device_type": "jstyle"}
        self.gateway._init_device_state(second_jstyle)

        self.assertFalse(self.gateway._can_start_gatt_connection(second_jstyle))
        self.assertTrue(self.gateway._can_start_gatt_connection(self.LOGICAL_MAC))

    def test_connection_budget_allows_jstyle_when_wearos_occupies_reserved_slot(self):
        self.gateway._init_device_state(self.LOGICAL_MAC)
        self.gateway.device_state[self.LOGICAL_MAC]["connected"] = True
        jstyle = "21:02:02:06:9F:20"
        self.gateway.device_registry.registered_macs.add(jstyle)
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
        self.gateway.device_registry.registered_macs.update({
            connected_jstyle, waiting_jstyle
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
        self.gateway.device_registry.registered_macs.update({
            first_jstyle, second_jstyle, third_jstyle
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


class PatientAssignedRegistryTest(unittest.IsolatedAsyncioTestCase):
    PAIRED = "21:02:02:06:A0:F4"
    UNPAIRED = "21:02:02:06:9F:7F"

    async def test_registry_query_rejects_blank_patient_hn(self):
        cursor = Mock()
        cursor.fetchall.return_value = [{
            "mac": self.PAIRED,
            "device_no": "5_F4",
            "hm_number": "Tech4",
            "name": "Patient",
            "bed_no": "5",
            "device_type": "jstyle",
        }]
        connection = Mock()
        connection.cursor.return_value = cursor
        registry = DeviceRegistry("db", 5432, "nurseaid", "user", "password")

        with patch(
            "nurseaid_ble_gateway.psycopg2.connect", return_value=connection
        ):
            count, new_count, removed_count = await registry.sync_from_db()

        query = cursor.execute.call_args.args[0]
        self.assertIn("NULLIF(BTRIM(hm_number), '') IS NOT NULL", query)
        self.assertEqual((1, 1, 0), (count, new_count, removed_count))
        self.assertEqual({self.PAIRED}, registry.registered_macs)

    async def test_unpaired_monitor_is_cancelled_and_removed(self):
        gateway = NurseAidBLEGateway()
        gateway.device_registry = SimpleNamespace(
            registered_macs={self.PAIRED},
            device_metadata={self.PAIRED: {"device_type": "jstyle"}},
        )
        gateway._init_device_state(self.PAIRED)
        gateway._init_device_state(self.UNPAIRED)
        gateway.discovered[self.UNPAIRED] = {"seen": time.time()}
        state = gateway.device_state[self.UNPAIRED]
        state["connected"] = True

        async def active_monitor():
            try:
                await asyncio.Event().wait()
            finally:
                state["connected"] = False
                state["task"] = None

        monitor_task = asyncio.create_task(active_monitor())
        state["task"] = monitor_task
        await asyncio.sleep(0)

        await gateway._reconcile_registered_devices()

        self.assertTrue(monitor_task.cancelled())
        self.assertNotIn(self.UNPAIRED, gateway.discovered)
        self.assertNotIn(self.UNPAIRED, gateway.device_state)
        self.assertIn(self.PAIRED, gateway.device_state)

    async def test_unpaired_connect_attempt_cannot_take_a_gatt_slot(self):
        gateway = NurseAidBLEGateway()
        gateway.device_registry = SimpleNamespace(
            registered_macs=set(),
            device_metadata={},
        )
        gateway._init_device_state(self.UNPAIRED)
        gateway.device_state[self.UNPAIRED]["connecting"] = True
        gateway.discovered[self.UNPAIRED] = {"seen": time.time()}

        await gateway._reconcile_registered_devices()

        self.assertNotIn(self.UNPAIRED, gateway.discovered)
        self.assertFalse(gateway._can_start_gatt_connection(self.UNPAIRED))
        self.assertFalse(gateway.device_state[self.UNPAIRED]["registry_active"])


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


class WearOSNotificationFramingTest(unittest.TestCase):
    MAC = "2E:1C:B8:CF:AF:06"

    def setUp(self):
        self.gateway = NurseAidBLEGateway()
        self.gateway.device_registry = SimpleNamespace(
            registered_macs={self.MAC},
            device_metadata={self.MAC: {"device_type": "wearos"}},
        )
        self.gateway.vitals_publisher = Mock()
        self.gateway._init_device_state(self.MAC)

    def test_fragmented_json_is_published_only_after_complete_frame(self):
        self.gateway._on_wearos_notification(
            self.MAC, b'{"hr":72,"spo2":'
        )
        self.gateway.vitals_publisher.publish_vitals.assert_not_called()

        self.gateway._on_wearos_notification(
            self.MAC, b'98,"temp":36.5,"status":1}'
        )

        self.gateway.vitals_publisher.publish_vitals.assert_called_once()
        payload = self.gateway.vitals_publisher.publish_vitals.call_args.args[1]
        self.assertEqual(72, payload["hr"])
        self.assertEqual(98, payload["spo2"])
        self.assertEqual(36.5, payload["temp"])
        self.assertEqual(b"", self.gateway.device_state[self.MAC]["wearos_rx_buffer"])

    def test_multiple_json_frames_in_one_notification_are_all_published(self):
        self.gateway._on_wearos_notification(
            self.MAC,
            b'noise{"hr":70,"provider":"wear{os}"}{"hr":71}\x00',
        )

        payloads = [
            call.args[1]
            for call in self.gateway.vitals_publisher.publish_vitals.call_args_list
        ]
        self.assertEqual([70, 71], [payload["hr"] for payload in payloads])

    def test_stale_partial_frame_does_not_corrupt_the_next_message(self):
        with patch("nurseaid_ble_gateway.time.time", return_value=1_000.0):
            self.gateway._on_wearos_notification(self.MAC, b'{"hr":')
        with patch("nurseaid_ble_gateway.time.time", return_value=1_006.0):
            self.gateway._on_wearos_notification(
                self.MAC, b'{"hr":73,"status":1}'
            )

        self.gateway.vitals_publisher.publish_vitals.assert_called_once()
        payload = self.gateway.vitals_publisher.publish_vitals.call_args.args[1]
        self.assertEqual(73, payload["hr"])

    def test_repeated_malformed_frames_request_a_clean_reconnect(self):
        state = self.gateway.device_state[self.MAC]

        with patch("nurseaid_ble_gateway.WEAROS_MAX_CONSECUTIVE_PARSE_ERRORS", 3):
            for _ in range(3):
                self.gateway._on_wearos_notification(
                    self.MAC, b'{"hr":72 "status":1}'
                )

        self.gateway.vitals_publisher.publish_vitals.assert_not_called()
        self.assertEqual(3, state["wearos_parse_error_count"])
        self.assertEqual(0, state["wearos_parse_error_streak"])
        self.assertTrue(state["wearos_protocol_error_event"].is_set())

    def test_valid_frame_resets_malformed_frame_streak(self):
        state = self.gateway.device_state[self.MAC]
        self.gateway._on_wearos_notification(
            self.MAC, b'{"hr":72 "status":1}'
        )
        self.assertEqual(1, state["wearos_parse_error_streak"])

        self.gateway._on_wearos_notification(
            self.MAC, b'{"hr":72,"status":1}'
        )

        self.assertEqual(0, state["wearos_parse_error_streak"])
        self.gateway.vitals_publisher.publish_vitals.assert_called_once()


class ScannerRecoveryTest(unittest.IsolatedAsyncioTestCase):
    async def test_hard_connect_deadline_cancels_a_wedged_bluez_call(self):
        gateway = NurseAidBLEGateway()
        cancelled = asyncio.Event()

        async def stuck_connect():
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        client = SimpleNamespace(connect=stuck_connect)
        started = asyncio.get_running_loop().time()

        with patch("nurseaid_ble_gateway.BLE_CONNECT_TIMEOUT", 0.01):
            with self.assertRaises(asyncio.TimeoutError):
                await gateway._connect_client_with_deadline(client)

        await asyncio.sleep(0)
        self.assertLess(asyncio.get_running_loop().time() - started, 0.5)
        self.assertTrue(cancelled.is_set())

    async def test_connect_timeout_records_failure_and_restores_adapter_scanner(self):
        gateway = NurseAidBLEGateway()
        mac = "21:02:02:05:F9:DD"
        address = "18:69:45:F3:45:77"
        other_address = "2C:CF:67:54:42:05"
        device = object()
        gateway.device_registry = SimpleNamespace(
            registered_macs={mac},
            device_metadata={mac: {"device_type": "jstyle"}},
        )
        gateway.vitals_publisher = Mock()
        gateway.adapter_manager.set_inventory([
            AdapterRuntime(address, "hci0"),
            AdapterRuntime(other_address, "hci1"),
        ])
        gateway.adapter_locks[address] = asyncio.Lock()
        gateway._init_device_state(mac)
        current = {
            "device": device,
            "rssi": -65,
            "seen": time.time(),
            "ble_address": mac,
            "local_name": "J2208A 05F9DD",
            "adapter_address": address,
        }
        gateway.discovered[mac] = current.copy()
        gateway.scanners[address] = object()

        async def stuck_connect():
            await asyncio.Event().wait()

        client = SimpleNamespace(
            connect=stuck_connect,
            disconnect=AsyncMock(),
            is_connected=False,
        )

        async def stop_scanner(_address):
            gateway.scanners.pop(address, None)

        with patch("nurseaid_ble_gateway.BLE_DUAL_ADAPTER_MODE", "adaptive"), patch(
            "nurseaid_ble_gateway.BLE_CONNECT_TIMEOUT", 0.01
        ), patch(
            "nurseaid_ble_gateway.BLE_CONNECT_CLEANUP_TIMEOUT", 0.01
        ), patch(
            "nurseaid_ble_gateway.BleakClient", return_value=client
        ), patch.object(
            gateway, "_wait_for_fresh_candidate", new=AsyncMock(return_value=current)
        ), patch.object(
            gateway, "_stop_adapter_scanner", new=AsyncMock(side_effect=stop_scanner)
        ), patch.object(
            gateway, "_start_adapter_scanner", new=AsyncMock(return_value=True)
        ) as start_scanner, patch.object(
            gateway, "_run_shell", new=AsyncMock(return_value=True)
        ) as run_shell:
            await gateway.connect_and_monitor(mac, device)

        state = gateway.device_state[mac]
        self.assertFalse(state["connecting"])
        self.assertEqual(0, state["connect_deadline"])
        self.assertEqual(1, state["fail_count"])
        self.assertEqual(
            1,
            gateway.adapter_manager.stats[mac][address].connect_failures,
        )
        start_scanner.assert_awaited_once_with(address)
        run_shell.assert_awaited_once_with(
            f"bluetoothctl disconnect {mac}", timeout=0.01
        )

    async def test_watchdog_restores_a_missing_idle_adapter_scanner(self):
        gateway = NurseAidBLEGateway()
        runtime = AdapterRuntime("18:69:45:F3:45:77", "hci0")
        gateway.adapter_manager.set_inventory([runtime])

        with patch.object(
            gateway, "_start_adapter_scanner", new=AsyncMock(return_value=True)
        ) as start_scanner:
            await gateway._recover_dual_adapter_scanners(time.time())

        start_scanner.assert_awaited_once_with(runtime.address)

    async def test_watchdog_does_not_restart_scanner_during_bounded_connect(self):
        gateway = NurseAidBLEGateway()
        runtime = AdapterRuntime("18:69:45:F3:45:77", "hci0")
        gateway.adapter_manager.set_inventory([runtime])
        mac = "21:02:02:05:F9:DD"
        gateway._init_device_state(mac)
        state = gateway.device_state[mac]
        state.update({
            "adapter_address": runtime.address,
            "connecting": True,
            "connect_deadline": time.time() + 30,
        })

        with patch.object(
            gateway, "_start_adapter_scanner", new=AsyncMock(return_value=True)
        ) as start_scanner:
            await gateway._recover_dual_adapter_scanners(time.time())

        start_scanner.assert_not_awaited()

    async def test_watchdog_does_not_churn_all_silent_idle_adapters(self):
        gateway = NurseAidBLEGateway()
        first = AdapterRuntime("18:69:45:F3:45:77", "hci0")
        second = AdapterRuntime("2C:CF:67:54:42:05", "hci1")
        gateway.adapter_manager.set_inventory([first, second])
        now = 1_000.0
        gateway.scanners = {first.address: object(), second.address: object()}
        gateway.scanner_started_at_by_adapter = {
            first.address: now - 100,
            second.address: now - 100,
        }
        gateway.last_advertisement_by_adapter = {
            first.address: 0,
            second.address: 0,
        }

        with patch("nurseaid_ble_gateway.BLE_SCANNER_STALE_SECONDS", 90), patch(
            "nurseaid_ble_gateway.BLE_SCANNER_IDLE_RESTART_SECONDS", 900
        ), patch.object(
            gateway, "_stop_adapter_scanner", new=AsyncMock()
        ) as stop_scanner, patch.object(
            gateway, "_start_adapter_scanner", new=AsyncMock(return_value=True)
        ) as start_scanner:
            await gateway._recover_dual_adapter_scanners(now)

        stop_scanner.assert_not_awaited()
        start_scanner.assert_not_awaited()

    async def test_watchdog_does_not_churn_silent_adapter_when_peer_sees_traffic(self):
        gateway = NurseAidBLEGateway()
        silent = AdapterRuntime("18:69:45:F3:45:77", "hci0")
        active = AdapterRuntime("2C:CF:67:54:42:05", "hci1")
        gateway.adapter_manager.set_inventory([silent, active])
        now = 1_000.0
        gateway.scanners = {silent.address: object(), active.address: object()}
        gateway.scanner_started_at_by_adapter = {
            silent.address: now - 100,
            active.address: now - 100,
        }
        gateway.last_advertisement_by_adapter = {
            silent.address: 0,
            active.address: now,
        }

        with patch("nurseaid_ble_gateway.BLE_SCANNER_STALE_SECONDS", 90), patch(
            "nurseaid_ble_gateway.BLE_SCANNER_IDLE_RESTART_SECONDS", 900
        ), patch.object(
            gateway, "_adapter_discovering", new=AsyncMock(return_value=True)
        ), patch.object(
            gateway, "_stop_adapter_scanner", new=AsyncMock()
        ) as stop_scanner, patch.object(
            gateway, "_start_adapter_scanner", new=AsyncMock(return_value=True)
        ) as start_scanner, patch(
            "nurseaid_ble_gateway.asyncio.sleep", new=AsyncMock()
        ):
            await gateway._recover_dual_adapter_scanners(now)

        stop_scanner.assert_not_awaited()
        start_scanner.assert_not_awaited()

    async def test_watchdog_recovers_scanner_when_bluez_discovery_stopped(self):
        gateway = NurseAidBLEGateway()
        runtime = AdapterRuntime("18:69:45:F3:45:77", "hci0")
        gateway.adapter_manager.set_inventory([runtime])
        now = 1_000.0
        gateway.scanners = {runtime.address: object()}
        gateway.scanner_started_at_by_adapter = {runtime.address: now - 100}
        gateway.last_advertisement_by_adapter = {runtime.address: 0}

        with patch("nurseaid_ble_gateway.BLE_SCANNER_STALE_SECONDS", 90), patch(
            "nurseaid_ble_gateway.BLE_SCANNER_IDLE_RESTART_SECONDS", 900
        ), patch.object(
            gateway, "_adapter_discovering", new=AsyncMock(return_value=False)
        ), patch.object(
            gateway, "_stop_adapter_scanner", new=AsyncMock()
        ) as stop_scanner, patch.object(
            gateway, "_start_adapter_scanner", new=AsyncMock(return_value=True)
        ) as start_scanner, patch(
            "nurseaid_ble_gateway.asyncio.sleep", new=AsyncMock()
        ):
            await gateway._recover_dual_adapter_scanners(now)

        stop_scanner.assert_awaited_once_with(runtime.address, force_bluez=True)
        start_scanner.assert_awaited_once_with(runtime.address)

    async def test_watchdog_retries_after_a_transient_cycle_exception(self):
        gateway = NurseAidBLEGateway()
        gateway.startup_cleanup_complete.set()

        with patch(
            "nurseaid_ble_gateway.asyncio.sleep",
            new=AsyncMock(side_effect=[None, asyncio.CancelledError()]),
        ), patch.object(
            gateway,
            "_watchdog_cycle",
            new=AsyncMock(side_effect=RuntimeError("transient D-Bus error")),
        ) as cycle, patch.object(gateway, "_write_health_state"):
            with self.assertRaises(asyncio.CancelledError):
                await gateway._connection_watchdog()

        cycle.assert_awaited_once()

    async def test_watchdog_waits_for_startup_cleanup(self):
        gateway = NurseAidBLEGateway()

        with patch.object(gateway, "_watchdog_cycle", new=AsyncMock()) as cycle:
            task = asyncio.create_task(gateway._connection_watchdog())
            await asyncio.sleep(0)
            cycle.assert_not_awaited()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

    async def test_adapter_initialization_disables_pairing_on_every_discovered_controller(self):
        gateway = NurseAidBLEGateway()
        inventory = [
            AdapterRuntime("18:69:45:F3:45:77", "hci0"),
            AdapterRuntime("2C:CF:67:54:42:05", "hci1"),
            AdapterRuntime("C0:3A:55:A5:3A:F0", "hci2"),
        ]

        with patch.object(
            gateway, "_discover_adapter_inventory", new=AsyncMock(return_value=inventory)
        ), patch.object(gateway, "_run_shell", new=AsyncMock(return_value=True)) as run_shell:
            await gateway._initialize_adapters()

        commands = [call.args[0] for call in run_shell.await_args_list]
        for interface in ("hci0", "hci1", "hci2"):
            self.assertIn(
                f"busctl set-property org.bluez /org/bluez/{interface} "
                "org.bluez.Adapter1 Pairable b false",
                commands,
            )
            self.assertIn(
                f"busctl set-property org.bluez /org/bluez/{interface} "
                "org.bluez.Adapter1 Discoverable b false",
                commands,
            )
        self.assertFalse(any(" pair " in command.lower() for command in commands))

    async def test_central_only_failure_does_not_stop_other_controllers(self):
        gateway = NurseAidBLEGateway()
        inventory = [
            AdapterRuntime("18:69:45:F3:45:77", "hci0"),
            AdapterRuntime("2C:CF:67:54:42:05", "hci1"),
        ]

        with patch.object(
            gateway, "_run_shell", new=AsyncMock(side_effect=[False, True, True, True])
        ) as run_shell:
            await gateway._enforce_central_only_mode(inventory)

        self.assertEqual(4, run_shell.await_count)

    async def test_startup_cleanup_releases_links_left_by_a_previous_gateway(self):
        gateway = NurseAidBLEGateway()
        gateway.adapter_manager.set_inventory([
            AdapterRuntime("18:69:45:F3:45:77", "hci0"),
            AdapterRuntime("2C:CF:67:54:42:05", "hci2"),
        ])
        process = SimpleNamespace(communicate=AsyncMock(return_value=(b'', b'')), returncode=0)

        with patch("nurseaid_ble_gateway.asyncio.create_subprocess_shell", new=AsyncMock(return_value=process)), patch.object(
            gateway, "_get_discovery_status", new=AsyncMock(return_value=False)
        ), patch.object(gateway, "_run_shell", new=AsyncMock(return_value=True)) as run_shell, patch(
            "nurseaid_ble_gateway.asyncio.sleep", new=AsyncMock()
        ):
            await gateway._startup_adapter_cleanup()

        cleanup_commands = "\n".join(call.args[0] for call in run_shell.await_args_list)
        self.assertNotIn("bluetoothctl devices Connected", cleanup_commands)
        for interface in ("hci0", "hci2"):
            self.assertIn(f"/org/bluez/{interface}/dev_", cleanup_commands)
        self.assertIn("org.bluez.Device1 Disconnect", cleanup_commands)
        self.assertIn("StopDiscovery", cleanup_commands)

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

    async def test_dual_scanner_start_resets_stale_age_and_sets_recovery_cooldown(self):
        gateway = NurseAidBLEGateway()
        runtime = AdapterRuntime("18:69:45:F3:45:77", "hci0")
        gateway.adapter_manager.set_inventory([runtime])
        gateway.scanner_locks[runtime.address] = asyncio.Lock()
        scanner = SimpleNamespace(start=AsyncMock())

        with patch.object(
            gateway, "_adapter_discovering", new=AsyncMock(return_value=False)
        ), patch("nurseaid_ble_gateway.BleakScanner", return_value=scanner), patch(
            "nurseaid_ble_gateway.time.time", return_value=1_000.0
        ):
            started = await gateway._start_adapter_scanner(runtime.address)

        self.assertTrue(started)
        self.assertEqual(0.0, gateway.last_advertisement_by_adapter.get(runtime.address, 0.0))
        self.assertGreater(gateway.scanner_recovery_until_by_adapter[runtime.address], 1_000.0)

    async def test_inprogress_stop_that_settles_does_not_repeat_bluez_stop(self):
        gateway = NurseAidBLEGateway()
        runtime = AdapterRuntime("18:69:45:F3:45:77", "hci0")
        gateway.adapter_manager.set_inventory([runtime])
        gateway.scanners[runtime.address] = SimpleNamespace(
            stop=AsyncMock(side_effect=RuntimeError("InProgress"))
        )

        with patch.object(
            gateway, "_adapter_discovering", new=AsyncMock(side_effect=[True, False])
        ), patch.object(gateway, "_run_shell", new=AsyncMock()) as run_shell, patch(
            "nurseaid_ble_gateway.asyncio.sleep", new=AsyncMock()
        ):
            await gateway._stop_adapter_scanner_locked(runtime.address, force_bluez=True)

        run_shell.assert_not_awaited()

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

    def test_dual_health_exposes_aggregate_per_adapter_state(self):
        gateway = NurseAidBLEGateway()
        first = AdapterRuntime("18:69:45:F3:45:77", "hci0")
        second = AdapterRuntime("2C:CF:67:54:42:05", "hci1")
        gateway.adapter_manager.set_inventory([first, second])
        now = time.time()
        gateway.last_advertisement_by_adapter = {first.address: now, second.address: now}
        gateway.scanners = {first.address: object(), second.address: object()}

        with patch("nurseaid_ble_gateway.BLE_HEALTH_FILE") as health_file, patch(
            "nurseaid_ble_gateway.BLE_DUAL_ADAPTER_MODE", "adaptive"
        ):
            gateway._write_health_state()

        payload = json.loads(health_file.with_suffix.return_value.write_text.call_args.args[0])
        self.assertEqual("healthy-dual", payload["status"])
        self.assertEqual({"hci0", "hci1"}, {
            item["interface"] for item in payload["adapters"].values()
        })

    def test_three_adapter_health_reports_multi_mode(self):
        gateway = NurseAidBLEGateway()
        adapters = [
            AdapterRuntime("18:69:45:F3:45:77", "hci0"),
            AdapterRuntime("C0:3A:55:A5:3A:F0", "hci1"),
            AdapterRuntime("2C:CF:67:54:42:05", "hci2"),
        ]
        gateway.adapter_manager.set_inventory(adapters)
        now = time.time()
        gateway.last_advertisement_by_adapter = {
            item.address: now for item in adapters
        }
        gateway.scanners = {item.address: object() for item in adapters}

        with patch("nurseaid_ble_gateway.BLE_HEALTH_FILE") as health_file, patch(
            "nurseaid_ble_gateway.BLE_DUAL_ADAPTER_MODE", "adaptive"
        ):
            gateway._write_health_state()

        payload = json.loads(health_file.with_suffix.return_value.write_text.call_args.args[0])
        self.assertEqual("multi", payload["mode"])
        self.assertEqual("healthy-multi", payload["status"])
        self.assertEqual({"hci0", "hci1", "hci2"}, {
            item["interface"] for item in payload["adapters"].values()
        })

    def test_health_reports_null_advertisement_age_before_first_packet(self):
        gateway = NurseAidBLEGateway()
        runtime = AdapterRuntime("18:69:45:F3:45:77", "hci0")
        gateway.adapter_manager.set_inventory([runtime])
        gateway.scanners = {runtime.address: object()}
        gateway.scanner_started_at_by_adapter = {runtime.address: 950.0}
        gateway.last_advertisement_by_adapter = {runtime.address: 0.0}

        with patch("nurseaid_ble_gateway.time.time", return_value=1_000.0), patch(
            "nurseaid_ble_gateway.BLE_HEALTH_FILE"
        ) as health_file:
            gateway._write_health_state()

        payload = json.loads(health_file.with_suffix.return_value.write_text.call_args.args[0])
        adapter = payload["adapters"][runtime.address]
        self.assertIsNone(adapter["lastAdvertisementAgeSeconds"])
        self.assertTrue(adapter["healthy"])

    def test_inactive_scanner_is_not_healthy_even_with_a_recent_timestamp(self):
        gateway = NurseAidBLEGateway()
        runtime = AdapterRuntime("18:69:45:F3:45:77", "hci0")
        gateway.adapter_manager.set_inventory([runtime])
        gateway.last_advertisement_by_adapter = {runtime.address: time.time()}

        with patch("nurseaid_ble_gateway.BLE_HEALTH_FILE") as health_file:
            gateway._write_health_state()

        payload = json.loads(health_file.with_suffix.return_value.write_text.call_args.args[0])
        self.assertFalse(payload["adapters"][runtime.address]["healthy"])

    def test_dual_scanner_detects_capacity_missing_on_only_one_adapter(self):
        gateway = NurseAidBLEGateway()
        first = AdapterRuntime("18:69:45:F3:45:77", "hci0")
        second = AdapterRuntime("2C:CF:67:54:42:05", "hci1")
        gateway.adapter_manager.set_inventory([first, second])
        gateway.scanners = {first.address: object()}
        gateway.scanner = gateway.scanners[first.address]

        with patch("nurseaid_ble_gateway.BLE_DUAL_ADAPTER_MODE", "adaptive"):
            self.assertTrue(gateway._scanner_capacity_missing())
            gateway.scanners[second.address] = object()
            self.assertFalse(gateway._scanner_capacity_missing())

    def test_full_or_unhealthy_adapter_does_not_request_scanner(self):
        gateway = NurseAidBLEGateway()
        first = AdapterRuntime("18:69:45:F3:45:77", "hci0")
        second = AdapterRuntime("2C:CF:67:54:42:05", "hci1", healthy=False)
        gateway.adapter_manager.set_inventory([first, second])
        first.active_connections = gateway.adapter_manager.max_connections_per_adapter

        with patch("nurseaid_ble_gateway.BLE_DUAL_ADAPTER_MODE", "adaptive"):
            self.assertFalse(gateway._scanner_capacity_missing())


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

    def test_single_off_wrist_packet_does_not_stop_measurement(self):
        self.gateway.vitals_publisher = Mock()
        packet = bytes.fromhex("09000000000000000000000000000000000000000000680100")

        self.gateway._on_notification(self.MAC, packet)

        state = self.gateway.device_state[self.MAC]
        self.assertIsNone(state["is_wearing"])
        self.assertFalse(state["stop_measurement_requested"])

    def test_startup_off_wrist_packets_are_ignored_during_connection_grace(self):
        self.gateway.vitals_publisher = Mock()
        state = self.gateway.device_state[self.MAC]
        state["connected_time"] = 1000.0
        packet = bytes.fromhex("09000000000000000000000000000000000000000000680100")

        with patch("nurseaid_ble_gateway.JSTYLE_STARTUP_OFF_WRIST_GRACE", 30.0):
            for packet_time in (1001.0, 1005.0, 1029.0):
                with patch("nurseaid_ble_gateway.time.time", return_value=packet_time):
                    self.gateway._on_notification(self.MAC, packet)

        self.assertIsNone(state["is_wearing"])
        self.assertEqual(0, state["off_wrist_confirmation_count"])
        self.assertFalse(state["stop_measurement_requested"])

    def test_off_wrist_cannot_be_confirmed_before_a_worn_baseline(self):
        self.gateway.vitals_publisher = Mock()
        state = self.gateway.device_state[self.MAC]
        state["connected_time"] = 1000.0
        packet = bytes.fromhex("09000000000000000000000000000000000000000000680100")

        with patch("nurseaid_ble_gateway.JSTYLE_STARTUP_OFF_WRIST_GRACE", 30.0):
            for packet_time in (1040.0, 1045.0, 1050.0):
                with patch("nurseaid_ble_gateway.time.time", return_value=packet_time):
                    self.gateway._on_notification(self.MAC, packet)

        self.assertIsNone(state["is_wearing"])
        self.assertFalse(state["stop_measurement_requested"])
        self.assertEqual(0, state["off_wrist_confirmation_count"])

    def test_confirmed_off_wrist_requests_early_stop_and_probe_delay(self):
        self.gateway.vitals_publisher = Mock()
        self.gateway.device_state[self.MAC]["worn_confirmed_since_start"] = True
        packet = bytes.fromhex("09000000000000000000000000000000000000000000680100")
        before = time.time()

        packet_times = [
            before + (index * max(1.0, JSTYLE_OFF_WRIST_MIN_CONFIRMATION_SECONDS))
            for index in range(JSTYLE_OFF_WRIST_CONFIRMATIONS)
        ]
        for packet_time in packet_times:
            with patch("nurseaid_ble_gateway.time.time", return_value=packet_time):
                self.gateway._on_notification(self.MAC, packet)

        state = self.gateway.device_state[self.MAC]
        self.assertEqual(0, state["is_wearing"])
        self.assertTrue(state["stop_measurement_requested"])
        self.assertGreaterEqual(
            state["off_wrist_probe_after"], before + JSTYLE_OFF_WRIST_PROBE_INTERVAL - 1
        )
        self.assertTrue(self.gateway._defer_off_wrist_device(state, before + 1))
        self.assertTrue(self.gateway._off_wrist_probe_due(
            state, state["off_wrist_probe_after"]
        ))

    def test_rapid_off_wrist_packets_do_not_blank_a_worn_device(self):
        self.gateway.vitals_publisher = Mock()
        state = self.gateway.device_state[self.MAC]
        state["is_wearing"] = 1
        packet = bytes.fromhex("09000000000000000000000000000000000000000000680100")

        for packet_time in [1000.0, 1000.2, 1000.4]:
            with patch("nurseaid_ble_gateway.time.time", return_value=packet_time):
                self.gateway._on_notification(self.MAC, packet)

        self.assertEqual(1, state["is_wearing"])
        self.assertFalse(state["stop_measurement_requested"])
        published = [call.args[1] for call in self.gateway.vitals_publisher.publish_vitals.call_args_list]
        self.assertTrue(all("status" not in payload for payload in published))

    def test_worn_packet_cancels_pending_off_wrist_suspicion(self):
        self.gateway.vitals_publisher = Mock()
        off_wrist = bytes.fromhex("09000000000000000000000000000000000000000000680100")
        worn = bytes.fromhex("0900000000000000000000000000000000000000003c69015f")

        with patch("nurseaid_ble_gateway.time.time", return_value=1000.0):
            self.gateway._on_notification(self.MAC, off_wrist)
        with patch("nurseaid_ble_gateway.time.time", return_value=1000.5):
            self.gateway._on_notification(self.MAC, off_wrist)
        with patch("nurseaid_ble_gateway.time.time", return_value=1001.0):
            self.gateway._on_notification(self.MAC, worn)

        state = self.gateway.device_state[self.MAC]
        self.assertEqual(1, state["is_wearing"])
        self.assertEqual(0, state["off_wrist_confirmation_count"])
        self.assertEqual(0, state["off_wrist_confirmation_started_at"])

    def test_worn_packet_clears_off_wrist_probe_state(self):
        self.gateway.vitals_publisher = Mock()
        state = self.gateway.device_state[self.MAC]
        state.update({
            "is_wearing": 0,
            "off_wrist_confirmation_count": JSTYLE_OFF_WRIST_CONFIRMATIONS,
            "off_wrist_probe_after": time.time() + 90,
            "stop_measurement_requested": True,
            "wear_probe_active": True,
        })
        packet = bytes.fromhex("0900000000000000000000000000000000000000003c69015f")

        self.gateway._on_notification(self.MAC, packet)

        self.assertEqual(1, state["is_wearing"])
        self.assertEqual(0, state["off_wrist_probe_after"])
        self.assertFalse(state["stop_measurement_requested"])
        self.assertFalse(state["wear_probe_active"])

    def test_stale_off_wrist_suspicion_restarts_confirmation(self):
        self.gateway.vitals_publisher = Mock()
        state = self.gateway.device_state[self.MAC]
        state["worn_confirmed_since_start"] = True
        state["off_wrist_confirmation_count"] = 1
        state["off_wrist_confirmation_started_at"] = (
            time.time() - JSTYLE_OFF_WRIST_CONFIRMATION_WINDOW - 1
        )
        packet = bytes.fromhex("09000000000000000000000000000000000000000000680100")

        self.gateway._on_notification(self.MAC, packet)

        self.assertEqual(1, state["off_wrist_confirmation_count"])
        self.assertIsNone(state["is_wearing"])

    def test_off_wrist_suspicion_uses_longer_retry_cooldown(self):
        state = self.gateway.device_state[self.MAC]
        state["is_wearing"] = None
        state["off_wrist_confirmation_count"] = 1

        self.assertEqual(
            JSTYLE_OFF_WRIST_SUSPECT_RETRY,
            self.gateway._jstyle_rotation_cooldown(state, 5),
        )

        state["is_wearing"] = 0
        self.assertEqual(
            JSTYLE_OFF_WRIST_PROBE_INTERVAL,
            self.gateway._jstyle_rotation_cooldown(state, 5),
        )

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

    def test_jstyle_measurements_do_not_use_a_global_wait_lock(self):
        self.assertFalse(hasattr(self.gateway, "jstyle_measurement_lock"))

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
        third = self.gateway._retry_backoff(3)
        much_later = self.gateway._retry_backoff(20)

        self.assertEqual(0.0, first)
        self.assertGreater(second, first)
        self.assertGreater(third, second)
        self.assertGreaterEqual(much_later, third)
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

    def test_transient_off_wrist_spo2_packet_does_not_expose_or_clear_vitals(self):
        packet = bytes.fromhex("28030000000000006801000000000094")
        self.assertEqual(
            {"status": 0, "provider": "jstyle", "raw_provider": "jstyle_0x28"},
            JStyleDeviceHandler.parse_vitals(self.MAC, packet),
        )

        self.gateway.vitals_publisher = Mock()
        self.gateway.device_state[self.MAC]["monitor_phase"] = "spo2"
        self.gateway.device_state[self.MAC]["spo2_ready"] = True
        self.gateway._on_notification(self.MAC, packet)
        self.assertTrue(self.gateway.device_state[self.MAC]["spo2_ready"])
        self.assertFalse(self.gateway.device_state[self.MAC]["spo2_off_wrist_seen"])
        published = self.gateway.vitals_publisher.publish_vitals.call_args.args[1]
        self.assertNotIn("status", published)
        self.assertNotIn("spo2", published)

    def test_confirmed_off_wrist_spo2_packets_clear_pending_result(self):
        packet = bytes.fromhex("28030000000000006801000000000094")
        self.gateway.vitals_publisher = Mock()
        state = self.gateway.device_state[self.MAC]
        state["monitor_phase"] = "spo2"
        state["spo2_ready"] = True
        state["worn_confirmed_since_start"] = True

        for index in range(JSTYLE_OFF_WRIST_CONFIRMATIONS):
            packet_time = 1000.0 + index * max(1.0, JSTYLE_OFF_WRIST_MIN_CONFIRMATION_SECONDS)
            with patch("nurseaid_ble_gateway.time.time", return_value=packet_time):
                self.gateway._on_notification(self.MAC, packet)

        self.assertFalse(state["spo2_ready"])
        self.assertTrue(state["spo2_off_wrist_seen"])
        self.assertTrue(state["spo2_off_wrist_confirmed"])

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

    def test_publisher_preserves_confirmed_jstyle_off_wrist_status(self):
        mqtt = Mock()
        publisher = VitalsPublisher(mqtt, publish_interval=0)

        publisher.publish_vitals(self.MAC, {
            "status": 0, "provider": "jstyle"
        }, {})

        vitals = next(
            call.args[1] for call in mqtt.publish_json.call_args_list
            if call.args[0] == "ble/vitals"
        )
        legacy_status = next(
            call.args[1] for call in mqtt.publish_json.call_args_list
            if call.args[0] == "ble/status"
        )
        self.assertEqual(0, vitals["status"])
        self.assertEqual(0, legacy_status["value"])

    def test_activity_does_not_claim_device_is_worn(self):
        mqtt = Mock()
        publisher = VitalsPublisher(mqtt, publish_interval=0)

        publisher.publish_activity(self.MAC, "connecting", {"device_type": "jstyle"})

        vitals = next(
            call.args[1] for call in mqtt.publish_json.call_args_list
            if call.args[0] == "ble/vitals"
        )
        self.assertIsNone(vitals["status"])
        self.assertFalse(any(
            call.args[0] == "ble/status" for call in mqtt.publish_json.call_args_list
        ))

    def test_status_transition_bypasses_periodic_publish_throttle(self):
        mqtt = Mock()
        publisher = VitalsPublisher(mqtt, publish_interval=60)

        publisher.publish_vitals(self.MAC, {
            "status": 1, "provider": "jstyle"
        }, {})
        publisher.publish_vitals(self.MAC, {
            "status": 0, "provider": "jstyle"
        }, {})

        statuses = [
            call.args[1]["value"] for call in mqtt.publish_json.call_args_list
            if call.args[0] == "ble/status"
        ]
        self.assertEqual([1, 0], statuses)

class JStyleOffWristPhaseTest(unittest.IsolatedAsyncioTestCase):
    MAC = "21:02:02:06:9F:20"

    async def test_phase1_ends_immediately_after_confirmed_off_wrist(self):
        gateway = NurseAidBLEGateway()
        gateway.device_registry = SimpleNamespace(
            registered_macs={self.MAC},
            device_metadata={self.MAC: {"device_type": "jstyle"}},
        )
        gateway._init_device_state(self.MAC)
        gateway.device_state[self.MAC]["is_wearing"] = 0
        gateway.device_state[self.MAC]["stop_measurement_requested"] = True
        gateway.vitals_publisher = Mock()
        client = SimpleNamespace(is_connected=True)

        with patch.object(gateway, "_write_jstyle_command", new=AsyncMock()), patch(
            "nurseaid_ble_gateway.asyncio.sleep", new=AsyncMock()
        ):
            result = await gateway._phase1_hr_temp(client, self.MAC, {})

        self.assertEqual("off_wrist", result)

    async def test_wear_probe_timeout_remains_off_wrist(self):
        gateway = NurseAidBLEGateway()
        gateway.device_registry = SimpleNamespace(
            registered_macs={self.MAC},
            device_metadata={self.MAC: {"device_type": "jstyle"}},
        )
        gateway._init_device_state(self.MAC)
        state = gateway.device_state[self.MAC]
        state["is_wearing"] = 0
        state["wear_probe_active"] = True
        state["stop_measurement_requested"] = False
        gateway.vitals_publisher = Mock()
        client = SimpleNamespace(is_connected=True)

        with patch.object(gateway, "_write_jstyle_command", new=AsyncMock()), patch(
            "nurseaid_ble_gateway.asyncio.sleep", new=AsyncMock()
        ):
            result = await gateway._phase1_hr_temp(client, self.MAC, {})

        self.assertEqual("off_wrist", result)
        self.assertGreater(state["off_wrist_probe_after"], time.time())

    async def test_no_samples_ends_phase_before_full_timeout(self):
        gateway = NurseAidBLEGateway()
        gateway.device_registry = SimpleNamespace(
            registered_macs={self.MAC},
            device_metadata={self.MAC: {"device_type": "jstyle"}},
        )
        gateway._init_device_state(self.MAC)
        gateway.vitals_publisher = Mock()
        client = SimpleNamespace(is_connected=True)
        clock = iter(range(1000, 1100))

        with patch.object(gateway, "_write_jstyle_command", new=AsyncMock()), patch(
            "nurseaid_ble_gateway.asyncio.sleep", new=AsyncMock()
        ), patch("nurseaid_ble_gateway.time.time", side_effect=lambda: next(clock)):
            result = await gateway._phase1_hr_temp(client, self.MAC, {})

        self.assertEqual("no_samples", result)

    async def test_zero_hr_packet_gets_full_sensor_window_without_stream_restarts(self):
        gateway = NurseAidBLEGateway()
        gateway.device_registry = SimpleNamespace(
            registered_macs={self.MAC},
            device_metadata={self.MAC: {"device_type": "jstyle"}},
        )
        gateway._init_device_state(self.MAC)
        gateway.vitals_publisher = Mock()
        client = SimpleNamespace(is_connected=True)
        zero_hr_packet = bytes.fromhex(
            "09000000000000000000000000000000000000000000680100"
        )

        async def command(_client, _mac, label, *_payload):
            if label == "HR/Temp start":
                gateway._on_notification(self.MAC, zero_hr_packet)

        with patch.object(
            gateway, "_write_jstyle_command", new=AsyncMock(side_effect=command)
        ), patch(
            "nurseaid_ble_gateway.asyncio.sleep", new=AsyncMock()
        ), patch(
            "nurseaid_ble_gateway.PHASE_1_DURATION", 2
        ), patch(
            "nurseaid_ble_gateway.JSTYLE_FIRST_SAMPLE_TIMEOUT", 0
        ):
            result = await gateway._phase1_hr_temp(client, self.MAC, {})

        self.assertEqual("sensor_no_reading", result)
        self.assertTrue(
            gateway.device_state[self.MAC]["phase_hr_temp_packet_seen"]
        )


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
        async def write(_characteristic, frame):
            if frame[0] == 0x28 and frame[2] == 0x01:
                state["last_spo2_value"] = 97
                state["spo2_samples"] = [(97, 82)]
                state["spo2_candidate_count"] = 1
                state["spo2_ready"] = True
                state["spo2_final_event"].set()

        client = SimpleNamespace(is_connected=True, write_gatt_char=AsyncMock(side_effect=write))

        with patch("nurseaid_ble_gateway.SPO2_SENSOR_SETTLE_SECONDS", 0):
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
        async def write(_characteristic, frame):
            if frame[0] == 0x28 and frame[2] == 0x01:
                state["spo2_off_wrist_seen"] = True
                state["spo2_off_wrist_confirmed"] = True
                state["off_wrist_event"].set()

        client.write_gatt_char = AsyncMock(side_effect=write)

        with patch("nurseaid_ble_gateway.SPO2_SENSOR_SETTLE_SECONDS", 0):
            received = await gateway._phase2_spo2(client, self.MAC)

        self.assertFalse(received)
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
        with patch("nurseaid_ble_gateway.SPO2_SENSOR_SETTLE_SECONDS", 0), patch(
            "nurseaid_ble_gateway.SPO2_NO_PROGRESS_TIMEOUT", 0
        ):
            received = await gateway._phase2_spo2(client, self.MAC)

        self.assertFalse(received)
        self.assertEqual("spo2_no_progress", state["last_failure_reason"])
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
            "nurseaid_ble_gateway.SPO2_SENSOR_SETTLE_SECONDS", 0
        ), patch(
            "nurseaid_ble_gateway.asyncio.sleep", new=boundary_sleep
        ):
            received = await gateway._phase2_spo2(client, self.MAC)

        self.assertTrue(received)
        self.assertTrue(state["spo2_ready"])
        self.assertEqual("verified", state["spo2_quality"])
        gateway.vitals_publisher.publish_spo2_quality.assert_any_call(
            self.MAC, "verified", {}, value=97, samples=1
        )

    async def test_two_devices_measure_spo2_concurrently(self):
        gateway = NurseAidBLEGateway()
        second_mac = "21:02:02:06:A0:63"
        for mac in (self.MAC, second_mac):
            gateway._init_device_state(mac)
            gateway.device_state[mac]["is_wearing"] = 1
        gateway.vitals_publisher = Mock()

        started = set()
        values = {self.MAC: 97, second_mac: 98}

        def client_for(mac, value):
            async def write(_characteristic, frame):
                if frame[0] == 0x28 and frame[2] == 0x01:
                    started.add(mac)
                    if len(started) == 2:
                        for ready_mac, ready_value in values.items():
                            state = gateway.device_state[ready_mac]
                            state["last_spo2_value"] = ready_value
                            state["spo2_samples"] = [(ready_value, 80)]
                            state["spo2_candidate_count"] = 1
                            state["spo2_ready"] = True
                            state["spo2_final_event"].set()
            return SimpleNamespace(is_connected=True, write_gatt_char=AsyncMock(side_effect=write))

        with patch("nurseaid_ble_gateway.SPO2_SENSOR_SETTLE_SECONDS", 0):
            results = await asyncio.wait_for(
                asyncio.gather(
                    gateway._phase2_spo2(client_for(self.MAC, 97), self.MAC),
                    gateway._phase2_spo2(client_for(second_mac, 98), second_mac),
                ),
                timeout=1,
            )

        self.assertEqual([True, True], results)
        self.assertEqual({self.MAC, second_mac}, started)
        self.assertEqual("spo2_verified", gateway.device_state[self.MAC]["last_result"])
        self.assertEqual("spo2_verified", gateway.device_state[second_mac]["last_result"])

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

    async def test_silent_spo2_stream_retries_once_without_false_empty_cycle(self):
        gateway = NurseAidBLEGateway()
        gateway._init_device_state(self.MAC)
        gateway.vitals_publisher = Mock()
        state = gateway.device_state[self.MAC]
        state["is_wearing"] = 1
        client = SimpleNamespace(is_connected=True)
        attempts = 0

        async def phase(_client, _mac):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                state["last_failure_reason"] = "spo2_no_progress"
                return False
            state["cycle_clinical_success"] = True
            state["last_failure_reason"] = None
            return True

        with patch("nurseaid_ble_gateway.JSTYLE_SPO2_STREAM_RETRIES", 1), patch(
            "nurseaid_ble_gateway.JSTYLE_SPO2_RETRY_DELAY", 0
        ), patch.object(gateway, "_phase2_spo2", side_effect=phase):
            received = await gateway._phase2_spo2_with_retries(client, self.MAC)

        self.assertTrue(received)
        self.assertEqual(2, attempts)
        self.assertEqual(0, gateway.empty_clinical_cycles)
        self.assertEqual(1, gateway.clinical_successes)
        self.assertFalse(state["measurement_slot_held"])
        gateway.vitals_publisher.publish_spo2_quality.assert_any_call(
            self.MAC, "retrying", {}, attempt=2, max_attempts=2
        )

    async def test_off_wrist_spo2_failure_is_not_retried(self):
        gateway = NurseAidBLEGateway()
        gateway._init_device_state(self.MAC)
        gateway.vitals_publisher = Mock()
        state = gateway.device_state[self.MAC]
        state["is_wearing"] = 1
        client = SimpleNamespace(is_connected=True)

        async def phase(_client, _mac):
            state["is_wearing"] = 0
            state["last_failure_reason"] = "spo2_off_wrist"
            return False

        with patch("nurseaid_ble_gateway.JSTYLE_SPO2_STREAM_RETRIES", 2), patch.object(
            gateway, "_phase2_spo2", new=AsyncMock(side_effect=phase)
        ) as phase2:
            received = await gateway._phase2_spo2_with_retries(client, self.MAC)

        self.assertFalse(received)
        phase2.assert_awaited_once_with(client, self.MAC)
        self.assertEqual(0, gateway.empty_clinical_cycles)

    async def test_hr_stream_retry_is_not_counted_as_sensor_failure(self):
        gateway = NurseAidBLEGateway()
        gateway.device_registry = SimpleNamespace(
            registered_macs={self.MAC},
            device_metadata={self.MAC: {"device_type": "jstyle"}},
        )
        gateway._init_device_state(self.MAC)
        gateway.vitals_publisher = Mock()
        state = gateway.device_state[self.MAC]
        state["connected"] = True
        state["is_wearing"] = 1
        client = SimpleNamespace(
            is_connected=True,
            start_notify=AsyncMock(),
            write_gatt_char=AsyncMock(),
            disconnect=AsyncMock(),
        )
        phase_calls = 0

        async def phase1(_client, _mac, _metadata):
            nonlocal phase_calls
            phase_calls += 1
            if phase_calls == 1:
                return "no_samples"
            client.is_connected = False
            return "disconnected"

        with patch("nurseaid_ble_gateway.JSTYLE_FIRST_SAMPLE_RETRIES", 1), patch.object(
            gateway, "_phase1_hr_temp", side_effect=phase1
        ), patch.object(gateway, "_write_jstyle_command", new=AsyncMock()), patch(
            "nurseaid_ble_gateway.asyncio.sleep", new=AsyncMock()
        ):
            await gateway._keep_monitoring(client, self.MAC)

        self.assertEqual(2, phase_calls)
        self.assertEqual(1, gateway.empty_clinical_cycles)

    async def test_transient_gatt_write_is_retried_once(self):
        gateway = NurseAidBLEGateway()
        gateway._init_device_state(self.MAC)
        client = SimpleNamespace(
            is_connected=True,
            write_gatt_char=AsyncMock(
                side_effect=[RuntimeError("GATT Protocol Error: Unlikely Error"), None]
            ),
        )

        with patch("nurseaid_ble_gateway.JSTYLE_COMMAND_RETRIES", 1), patch(
            "nurseaid_ble_gateway.JSTYLE_COMMAND_RETRY_DELAY", 0
        ):
            await gateway._write_jstyle_command(
                client, self.MAC, "SpO2 start", 0x28, 0x03, 0x01
            )

        self.assertEqual(2, client.write_gatt_char.await_count)

    async def test_transient_notify_setup_is_retried_once(self):
        gateway = NurseAidBLEGateway()
        gateway._init_device_state(self.MAC)
        client = SimpleNamespace(
            is_connected=True,
            start_notify=AsyncMock(
                side_effect=[RuntimeError("org.bluez.Error.Failed"), None]
            ),
        )

        with patch("nurseaid_ble_gateway.JSTYLE_COMMAND_RETRIES", 1), patch(
            "nurseaid_ble_gateway.JSTYLE_COMMAND_RETRY_DELAY", 0
        ):
            await gateway._start_jstyle_notifications(client, self.MAC)

        self.assertEqual(2, client.start_notify.await_count)


class JStylePersistentSessionTest(unittest.IsolatedAsyncioTestCase):
    MAC = "21:02:02:06:9F:20"

    async def test_successful_cycle_continues_hr_temp_in_same_connection(self):
        gateway = NurseAidBLEGateway()
        gateway.device_registry = SimpleNamespace(
            registered_macs={self.MAC},
            device_metadata={self.MAC: {"device_type": "jstyle"}},
        )
        gateway._init_device_state(self.MAC)
        gateway.vitals_publisher = Mock()
        state = gateway.device_state[self.MAC]
        state["connected"] = True
        state["is_wearing"] = 1

        client = SimpleNamespace(
            is_connected=True,
            start_notify=AsyncMock(),
            write_gatt_char=AsyncMock(),
            disconnect=AsyncMock(),
        )
        phase_calls = 0

        async def phase1(_client, _mac, _metadata):
            nonlocal phase_calls
            phase_calls += 1
            if phase_calls == 2:
                client.is_connected = False
            return "stable"

        with patch.object(gateway, "_phase1_hr_temp", side_effect=phase1), patch.object(
            gateway, "_phase2_spo2", new=AsyncMock(return_value=True)
        ) as phase2, patch("nurseaid_ble_gateway.asyncio.sleep", new=AsyncMock()):
            await gateway._keep_monitoring(client, self.MAC)

        self.assertEqual(2, phase_calls)
        phase2.assert_awaited_once_with(client, self.MAC)
        self.assertEqual(1, state["completed_cycles"])

    async def test_first_sample_timeout_retries_in_same_connection(self):
        gateway = NurseAidBLEGateway()
        gateway.device_registry = SimpleNamespace(
            registered_macs={self.MAC},
            device_metadata={self.MAC: {"device_type": "jstyle"}},
        )
        gateway._init_device_state(self.MAC)
        gateway.vitals_publisher = Mock()
        state = gateway.device_state[self.MAC]
        state["connected"] = True
        state["is_wearing"] = 1
        client = SimpleNamespace(
            is_connected=True, start_notify=AsyncMock(),
            write_gatt_char=AsyncMock(), disconnect=AsyncMock(),
        )
        results = iter(["no_samples", "stable", "disconnected"])

        async def phase1(_client, _mac, _metadata):
            result = next(results)
            if result == "disconnected":
                client.is_connected = False
            return result

        retry_released_slot = False

        async def observe_sleep(_delay):
            nonlocal retry_released_slot
            if state.get("last_result") == "first_sample_retry":
                retry_released_slot = not state.get("measurement_slot_held")

        with patch.object(gateway, "_phase1_hr_temp", side_effect=phase1), patch.object(
            gateway, "_phase2_spo2", new=AsyncMock(return_value=True)
        ) as phase2, patch.object(
            gateway, "_write_jstyle_command", new=AsyncMock()
        ) as command, patch(
            "nurseaid_ble_gateway.asyncio.sleep",
            new=AsyncMock(side_effect=observe_sleep),
        ):
            await gateway._keep_monitoring(client, self.MAC)

        phase2.assert_awaited_once_with(client, self.MAC)
        self.assertTrue(any(call.args[2] == "HR/Temp retry stop" for call in command.await_args_list))
        self.assertTrue(retry_released_slot)

    async def test_first_sample_retry_limit_eventually_ends_session(self):
        gateway = NurseAidBLEGateway()
        gateway.device_registry = SimpleNamespace(
            registered_macs={self.MAC},
            device_metadata={self.MAC: {"device_type": "jstyle"}},
        )
        gateway._init_device_state(self.MAC)
        gateway.vitals_publisher = Mock()
        gateway.device_state[self.MAC]["connected"] = True
        client = SimpleNamespace(
            is_connected=True, start_notify=AsyncMock(),
            write_gatt_char=AsyncMock(), disconnect=AsyncMock(),
        )

        with patch("nurseaid_ble_gateway.JSTYLE_FIRST_SAMPLE_RETRIES", 1), patch.object(
            gateway, "_phase1_hr_temp", new=AsyncMock(return_value="no_samples")
        ) as phase1, patch.object(
            gateway, "_phase2_spo2", new=AsyncMock()
        ) as phase2, patch("nurseaid_ble_gateway.asyncio.sleep", new=AsyncMock()):
            await gateway._keep_monitoring(client, self.MAC)

        self.assertEqual(2, phase1.await_count)
        phase2.assert_not_awaited()

    async def test_sensor_zero_result_ends_without_retry_or_spo2(self):
        gateway = NurseAidBLEGateway()
        gateway.device_registry = SimpleNamespace(
            registered_macs={self.MAC},
            device_metadata={self.MAC: {"device_type": "jstyle"}},
        )
        gateway._init_device_state(self.MAC)
        gateway.vitals_publisher = Mock()
        gateway.device_state[self.MAC]["connected"] = True
        client = SimpleNamespace(
            is_connected=True, start_notify=AsyncMock(),
            write_gatt_char=AsyncMock(), disconnect=AsyncMock(),
        )

        with patch.object(
            gateway, "_phase1_hr_temp",
            new=AsyncMock(return_value="sensor_no_reading"),
        ) as phase1, patch.object(
            gateway, "_phase2_spo2", new=AsyncMock()
        ) as phase2, patch(
            "nurseaid_ble_gateway.asyncio.sleep", new=AsyncMock()
        ):
            await gateway._keep_monitoring(client, self.MAC)

        phase1.assert_awaited_once()
        phase2.assert_not_awaited()


class MeasurementSchedulerTest(unittest.IsolatedAsyncioTestCase):
    A = "18:69:45:F3:45:77"
    B = "2C:CF:67:54:42:05"
    MAC_A1 = "21:02:02:05:FF:9A"
    MAC_A2 = "21:02:02:06:9F:20"
    MAC_B1 = "21:02:02:06:A0:63"

    def setUp(self):
        self.gateway = NurseAidBLEGateway()
        self.gateway.vitals_publisher = Mock()
        self.gateway.device_registry = SimpleNamespace(device_metadata={})
        self.gateway.adapter_manager.set_inventory([
            AdapterRuntime(self.A, "hci0"), AdapterRuntime(self.B, "hci1")
        ])
        for mac, address in (
            (self.MAC_A1, self.A), (self.MAC_A2, self.A), (self.MAC_B1, self.B)
        ):
            self.gateway._init_device_state(mac)
            self.gateway.device_state[mac]["adapter_address"] = address
            self.gateway.device_state[mac]["connected"] = True

    async def test_same_adapter_measurements_are_serialized(self):
        with patch("nurseaid_ble_gateway.BLE_MAX_ACTIVE_MEASUREMENTS_PER_ADAPTER", 1):
            await self.gateway._acquire_measurement_slot(self.MAC_A1)
            waiting = asyncio.create_task(
                self.gateway._acquire_measurement_slot(self.MAC_A2)
            )
            await asyncio.sleep(0)

            self.assertFalse(waiting.done())
            self.assertEqual(1, self.gateway.adapter_manager.adapters[self.A].active_measurements)
            self.assertEqual(1, self.gateway.measurement_queue_depth[self.A])

            self.gateway._release_measurement_slot(self.MAC_A1)
            await asyncio.wait_for(waiting, timeout=1)
            self.assertTrue(self.gateway.device_state[self.MAC_A2]["measurement_slot_held"])
            self.assertEqual(1, self.gateway.adapter_manager.adapters[self.A].active_measurements)
            self.gateway._release_measurement_slot(self.MAC_A2)

    async def test_different_adapters_measure_in_parallel(self):
        with patch("nurseaid_ble_gateway.BLE_MAX_ACTIVE_MEASUREMENTS_PER_ADAPTER", 1):
            await asyncio.gather(
                self.gateway._acquire_measurement_slot(self.MAC_A1),
                self.gateway._acquire_measurement_slot(self.MAC_B1),
            )

        self.assertEqual(1, self.gateway.adapter_manager.adapters[self.A].active_measurements)
        self.assertEqual(1, self.gateway.adapter_manager.adapters[self.B].active_measurements)
        self.gateway._release_measurement_slot(self.MAC_A1)
        self.gateway._release_measurement_slot(self.MAC_B1)

    async def test_cancelled_waiter_does_not_leak_queue_or_slot(self):
        with patch("nurseaid_ble_gateway.BLE_MAX_ACTIVE_MEASUREMENTS_PER_ADAPTER", 1):
            await self.gateway._acquire_measurement_slot(self.MAC_A1)
            waiting = asyncio.create_task(
                self.gateway._acquire_measurement_slot(self.MAC_A2)
            )
            await asyncio.sleep(0)
            waiting.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiting

        self.assertEqual(0, self.gateway.measurement_queue_depth[self.A])
        self.assertFalse(self.gateway.device_state[self.MAC_A2]["measurement_slot_held"])
        self.gateway._release_measurement_slot(self.MAC_A1)
        self.assertEqual(0, self.gateway.adapter_manager.adapters[self.A].active_measurements)

    async def test_release_is_idempotent_and_records_one_cycle(self):
        with patch("nurseaid_ble_gateway.BLE_MAX_ACTIVE_MEASUREMENTS_PER_ADAPTER", 1):
            await self.gateway._acquire_measurement_slot(self.MAC_A1)
        self.gateway._record_device_data_success(self.MAC_A1, {
            "hr": 72, "status": 1, "provider": "jstyle"
        })
        self.gateway._release_measurement_slot(self.MAC_A1)
        self.gateway._release_measurement_slot(self.MAC_A1)

        stats = self.gateway.adapter_manager.stats[self.MAC_A1][self.A]
        self.assertEqual(1, stats.data_successes)
        self.assertEqual(0, stats.empty_cycles)
        self.assertEqual(1, self.gateway.clinical_successes)

    async def test_three_empty_cycles_publish_sensor_failure_through_vitals_publisher(self):
        metadata = {"device_type": "jstyle", "device_no": "1"}
        self.gateway.device_registry.device_metadata[self.MAC_A1] = metadata

        for _ in range(3):
            await self.gateway._acquire_measurement_slot(self.MAC_A1)
            self.gateway._release_measurement_slot(self.MAC_A1)

        sensor_failure_calls = [
            item for item in self.gateway.vitals_publisher.publish_activity.call_args_list
            if item.args[1] == "sensor_failure"
        ]
        self.assertEqual(1, len(sensor_failure_calls))
        self.assertEqual((self.MAC_A1, "sensor_failure", metadata), sensor_failure_calls[0].args)

        await self.gateway._acquire_measurement_slot(self.MAC_A1)
        self.gateway._release_measurement_slot(self.MAC_A1)
        sensor_failure_calls = [
            item for item in self.gateway.vitals_publisher.publish_activity.call_args_list
            if item.args[1] == "sensor_failure"
        ]
        self.assertEqual(1, len(sensor_failure_calls))

    def test_status_and_battery_packets_are_not_clinical_success(self):
        state = self.gateway.device_state[self.MAC_A1]
        self.assertFalse(self.gateway._record_device_data_success(
            self.MAC_A1, {"status": 0, "provider": "jstyle"}
        ))
        self.assertFalse(self.gateway._record_device_data_success(
            self.MAC_A1, {"batt": 80, "provider": "jstyle"}
        ))
        self.assertFalse(state["cycle_clinical_success"])

    def test_worn_hr_and_verified_spo2_are_clinical_success(self):
        state = self.gateway.device_state[self.MAC_A1]
        self.assertTrue(self.gateway._record_device_data_success(
            self.MAC_A1, {"hr": 72, "status": 1, "provider": "jstyle"}
        ))
        state["cycle_clinical_success"] = False
        self.assertTrue(self.gateway._record_device_data_success(
            self.MAC_A1, {"spo2": 98, "status": 1, "provider": "jstyle"}
        ))

    def test_operational_status_reports_slots_and_queue(self):
        state = self.gateway.device_state[self.MAC_A1]
        state["measurement_slot_held"] = True
        state["monitor_phase"] = "hr_temp"
        self.gateway.adapter_manager.adapters[self.A].active_measurements = 1
        self.gateway.measurement_queue_depth[self.A] = 2
        self.gateway.device_registry = SimpleNamespace(
            registered_macs={self.MAC_A1, self.MAC_A2}
        )

        status = self.gateway._operational_status()
        self.assertEqual(1, status["activeMeasurements"])
        self.assertEqual(1, status["activeHrTempMeasurements"])
        self.assertEqual(2, status["measurementQueueDepth"])
        self.assertEqual(2, status["adapters"]["hci0"]["measurementQueueDepth"])

    async def test_monitoring_exception_releases_measurement_slot(self):
        gateway = NurseAidBLEGateway()
        gateway.device_registry = SimpleNamespace(
            registered_macs={self.MAC_A1},
            device_metadata={self.MAC_A1: {"device_type": "jstyle"}},
        )
        gateway.adapter_manager.set_inventory([AdapterRuntime(self.A, "hci0")])
        gateway._init_device_state(self.MAC_A1)
        gateway.vitals_publisher = Mock()
        state = gateway.device_state[self.MAC_A1]
        state["adapter_address"] = self.A
        state["connected"] = True
        client = SimpleNamespace(
            is_connected=True,
            start_notify=AsyncMock(),
            write_gatt_char=AsyncMock(),
            disconnect=AsyncMock(),
        )

        with patch.object(
            gateway, "_phase1_hr_temp", new=AsyncMock(side_effect=RuntimeError("sensor failure"))
        ), patch("nurseaid_ble_gateway.asyncio.sleep", new=AsyncMock()):
            await gateway._keep_monitoring(client, self.MAC_A1)

        self.assertFalse(state["measurement_slot_held"])
        self.assertEqual(0, gateway.adapter_manager.adapters[self.A].active_measurements)
        self.assertEqual(1, gateway.empty_clinical_cycles)

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
