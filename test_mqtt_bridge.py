import importlib.util
import json
import pathlib
import unittest
from unittest.mock import Mock, patch


MODULE_PATH = pathlib.Path(__file__).parent / "mqtt-bridge" / "mqtt_bridge.py"
SPEC = importlib.util.spec_from_file_location("mqtt_bridge", MODULE_PATH)
mqtt_bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mqtt_bridge)


class MQTTBridgeWearStatusTest(unittest.TestCase):
    MAC = "21:02:02:06:9F:20"

    def setUp(self):
        mqtt_bridge.data_buffer.clear()
        mqtt_bridge.last_saved_time = 0

    def send(self, payload):
        message = Mock()
        message.topic = "ble/vitals"
        message.payload = json.dumps(payload).encode()
        mqtt_bridge.on_message(None, None, message)

    def send_topic(self, topic, payload):
        message = Mock()
        message.topic = topic
        message.payload = json.dumps(payload).encode()
        mqtt_bridge.on_message(None, None, message)

    def test_status_zero_does_not_double_filter_consolidated_vitals(self):
        self.send({
            "mac": self.MAC,
            "hr": 104,
            "spo2": 99,
            "temp": 36.0,
            "batt": 29,
            "status": 0,
        })

        self.assertEqual(104.0, mqtt_bridge.data_buffer["ble/heart"][self.MAC]["value"])
        self.assertEqual(99.0, mqtt_bridge.data_buffer["ble/spo2"][self.MAC]["value"])
        self.assertEqual(36.0, mqtt_bridge.data_buffer["ble/temp"][self.MAC]["value"])
        self.assertEqual(29.0, mqtt_bridge.data_buffer["ble/batt"][self.MAC]["value"])
        self.assertEqual(0.0, mqtt_bridge.data_buffer["ble/status"][self.MAC]["value"])

    def test_worn_payload_buffers_clinical_fields(self):
        self.send({"mac": self.MAC, "hr": 60, "spo2": 99, "temp": 36.1, "status": 1})

        self.assertEqual(60.0, mqtt_bridge.data_buffer["ble/heart"][self.MAC]["value"])
        self.assertEqual(99.0, mqtt_bridge.data_buffer["ble/spo2"][self.MAC]["value"])
        self.assertEqual(36.1, mqtt_bridge.data_buffer["ble/temp"][self.MAC]["value"])

    def test_activity_without_status_does_not_invent_wear_state(self):
        self.send({"mac": self.MAC, "activity": "connecting", "status": None})

        status = mqtt_bridge.data_buffer["ble/status"][self.MAC]
        self.assertEqual("connecting", status["activity"])
        self.assertNotIn("value", status)

    def test_off_wrist_legacy_clinical_value_is_rejected(self):
        self.send_topic("ble/heart", {"mac": self.MAC, "value": 104, "status": 0})

        self.assertEqual({}, mqtt_bridge.data_buffer["ble/heart"])

    def test_unverified_jstyle_spo2_is_not_buffered(self):
        self.send({
            "mac": self.MAC, "spo2": 76, "spo2_status": "unstable",
            "status": 1, "provider": "jstyle"
        })

        self.assertNotIn("ble/spo2", mqtt_bridge.data_buffer)

    def test_spo2_quality_status_is_buffered_separately(self):
        self.send_topic("ble/spo2_quality", {
            "mac": self.MAC, "status": "measuring", "rounds": 0
        })

        self.assertEqual("measuring", mqtt_bridge.data_buffer["ble/spo2_quality"][self.MAC]["status"])

    def test_save_data_writes_all_buffered_points_in_one_batch(self):
        self.send({"mac": self.MAC, "hr": 60, "temp": 36.1, "status": 1})

        with patch.object(mqtt_bridge.write_api, "write") as write:
            mqtt_bridge.save_data()

        write.assert_called_once()
        self.assertEqual(3, len(write.call_args.kwargs["record"]))
        self.assertEqual({}, mqtt_bridge.data_buffer)

    def test_source_timestamp_is_used_without_internal_fields_leaking(self):
        sample_ms = 1_784_700_000_123
        self.send({
            "mac": self.MAC, "hr": 60, "status": 1,
            "sample_epoch_ms": sample_ms,
        })

        with patch.object(mqtt_bridge.write_api, "write") as write:
            mqtt_bridge.save_data()

        heart = next(
            point for point in write.call_args.kwargs["record"]
            if point._name == "ble_heart"
        )
        self.assertEqual(sample_ms * 1_000_000, heart._time)
        self.assertNotIn("_timestamp_ns", heart._fields)
        self.assertNotIn("_received_at", heart._fields)

    def test_save_data_restores_failed_batch(self):
        self.send({"mac": self.MAC, "hr": 60, "status": 1})

        with patch.object(mqtt_bridge.write_api, "write", side_effect=RuntimeError("unavailable")):
            mqtt_bridge.save_data()

        self.assertEqual(60.0, mqtt_bridge.data_buffer["ble/heart"][self.MAC]["value"])
        self.assertEqual(1.0, mqtt_bridge.data_buffer["ble/status"][self.MAC]["value"])


if __name__ == "__main__":
    unittest.main()
