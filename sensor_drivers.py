"""Protocol adapters for BLE sensors supported by the NurseAid gateway.

Drivers in this module never publish data themselves.  They only identify a
protocol and translate protocol-specific bytes into a small normalized dict.
The gateway remains responsible for device registration, connection lifecycle,
quality policy, MQTT publishing, and patient metadata.

Xiaomi MiBeacon support intentionally covers only unencrypted environmental
objects.  Xiaomi bands and watches commonly require model-specific
authentication and are not treated as MiBeacon health devices.
"""

from dataclasses import dataclass
import math
import re
from typing import Callable, Dict, Optional, Tuple


DRIVER_MODE_JSTYLE = "jstyle_gatt"
DRIVER_MODE_WEAROS = "wearos_gatt"
DRIVER_MODE_STANDARD_GATT = "standard_gatt"
DRIVER_MODE_ADVERTISEMENT = "advertisement"
DRIVER_MODE_EXTERNAL = "external"
DRIVER_MODE_UNSUPPORTED = "unsupported"


@dataclass(frozen=True)
class SensorDriverSpec:
    """Describes how the gateway should handle one registered device type."""

    device_type: str
    display_name: str
    provider: str
    mode: str
    priority: int = 50
    advertisement_parser: Optional[Callable] = None
    advertisement_matcher: Optional[Callable] = None

    @property
    def connects_over_gatt(self) -> bool:
        return self.mode in {
            DRIVER_MODE_JSTYLE,
            DRIVER_MODE_WEAROS,
            DRIVER_MODE_STANDARD_GATT,
        }


class SensorDriverRegistry:
    """Explicit allow-list of protocols; unknown types are never guessed."""

    def __init__(self):
        self._drivers: Dict[str, SensorDriverSpec] = {}

    def register(self, spec: SensorDriverSpec) -> None:
        key = self.normalize_type(spec.device_type)
        if not key:
            raise ValueError("device_type is required")
        if key in self._drivers:
            raise ValueError(f"driver already registered: {key}")
        self._drivers[key] = spec

    def get(self, device_type: str) -> SensorDriverSpec:
        key = self.normalize_type(device_type)
        spec = self._drivers.get(key)
        if spec is not None:
            return spec
        return SensorDriverSpec(
            device_type=key or "unknown",
            display_name="Unsupported device",
            provider=key or "unknown",
            mode=DRIVER_MODE_UNSUPPORTED,
            priority=999,
        )

    def supported_types(self) -> Tuple[str, ...]:
        return tuple(self._drivers.keys())

    @staticmethod
    def normalize_type(value: str) -> str:
        return re.sub(r"[^a-z0-9_]+", "_", str(value or "").strip().lower()).strip("_")


class StandardGATTDeviceHandler:
    """Parser for Bluetooth SIG health and battery characteristics."""

    PROVIDER = "standard_gatt"

    HEART_RATE_MEASUREMENT = "00002a37-0000-1000-8000-00805f9b34fb"
    TEMPERATURE_MEASUREMENT = "00002a1c-0000-1000-8000-00805f9b34fb"
    BATTERY_LEVEL = "00002a19-0000-1000-8000-00805f9b34fb"
    PLX_SPOT_CHECK = "00002a5e-0000-1000-8000-00805f9b34fb"
    PLX_CONTINUOUS = "00002a5f-0000-1000-8000-00805f9b34fb"

    SUPPORTED_CHARACTERISTICS = {
        HEART_RATE_MEASUREMENT,
        TEMPERATURE_MEASUREMENT,
        BATTERY_LEVEL,
        PLX_SPOT_CHECK,
        PLX_CONTINUOUS,
    }

    @staticmethod
    def canonical_uuid(value: str) -> str:
        text = str(value or "").strip().lower()
        if re.fullmatch(r"[0-9a-f]{4}", text):
            return f"0000{text}-0000-1000-8000-00805f9b34fb"
        return text

    @staticmethod
    def _signed(value: int, bits: int) -> int:
        sign_bit = 1 << (bits - 1)
        return value - (1 << bits) if value & sign_bit else value

    @classmethod
    def _parse_ieee11073_float(cls, data: bytes) -> Optional[float]:
        if len(data) < 4:
            return None
        raw = int.from_bytes(data[:4], "little")
        mantissa = cls._signed(raw & 0xFFFFFF, 24)
        exponent = cls._signed((raw >> 24) & 0xFF, 8)
        # Reserved NaN/+Inf/-Inf values from IEEE 11073-20601.
        if mantissa in {0x7FFFFF, 0x7FFFFE, 0x800002, -0x800000, -0x7FFFFF}:
            return None
        try:
            result = mantissa * (10 ** exponent)
        except OverflowError:
            return None
        return float(result) if math.isfinite(result) else None

    @classmethod
    def _parse_sfloat(cls, data: bytes) -> Optional[float]:
        if len(data) < 2:
            return None
        raw = int.from_bytes(data[:2], "little")
        mantissa = cls._signed(raw & 0x0FFF, 12)
        exponent = cls._signed((raw >> 12) & 0x0F, 4)
        if mantissa in {0x07FF, 0x07FE, -0x0800, -0x07FE, -0x07FF}:
            return None
        result = mantissa * (10 ** exponent)
        return float(result) if math.isfinite(result) else None

    @classmethod
    def parse_characteristic(cls, characteristic_uuid: str, data: bytes) -> Optional[dict]:
        uuid = cls.canonical_uuid(characteristic_uuid)
        raw = bytes(data or b"")
        extracted = {
            "provider": cls.PROVIDER,
            "raw_provider": f"standard_gatt_{uuid[4:8] if len(uuid) >= 8 else uuid}",
        }

        if uuid == cls.HEART_RATE_MEASUREMENT:
            if len(raw) < 2:
                return None
            is_uint16 = bool(raw[0] & 0x01)
            if is_uint16:
                if len(raw) < 3:
                    return None
                heart_rate = int.from_bytes(raw[1:3], "little")
            else:
                heart_rate = raw[1]
            if not 20 <= heart_rate <= 250:
                return None
            extracted["hr"] = heart_rate

        elif uuid == cls.BATTERY_LEVEL:
            if not raw or raw[0] > 100:
                return None
            extracted["batt"] = raw[0]

        elif uuid == cls.TEMPERATURE_MEASUREMENT:
            if len(raw) < 5:
                return None
            temperature = cls._parse_ieee11073_float(raw[1:5])
            if temperature is None:
                return None
            if raw[0] & 0x01:  # unit flag: Fahrenheit
                temperature = (temperature - 32.0) * 5.0 / 9.0
            if not 25.0 <= temperature <= 45.0:
                return None
            extracted["temp"] = round(temperature, 1)
            extracted["temp_type"] = "body"

        elif uuid in {cls.PLX_SPOT_CHECK, cls.PLX_CONTINUOUS}:
            if len(raw) < 5:
                return None
            # Both mandatory PLX measurements start with Flags followed by the
            # SpO2 and pulse-rate SFLOAT pair. Optional fields follow the pair.
            spo2 = cls._parse_sfloat(raw[1:3])
            pulse = cls._parse_sfloat(raw[3:5])
            if spo2 is not None and 50 <= spo2 <= 100:
                extracted["spo2"] = int(round(spo2))
                extracted["spo2_quality"] = "verified"
            if pulse is not None and 20 <= pulse <= 250:
                extracted["hr"] = int(round(pulse))
            if "spo2" not in extracted and "hr" not in extracted:
                return None

        else:
            return None

        return extracted


class XiaomiMiBeaconDeviceHandler:
    """Safe parser for unencrypted Xiaomi MiBeacon environmental objects."""

    PROVIDER = "xiaomi_mibeacon"
    SERVICE_UUID = "0000fe95-0000-1000-8000-00805f9b34fb"

    FRAME_ENCRYPTED = 0x0008
    FRAME_MAC_INCLUDED = 0x0010
    FRAME_CAPABILITY_INCLUDED = 0x0020
    FRAME_OBJECT_INCLUDED = 0x0040

    @staticmethod
    def _service_payload(advertisement_data) -> Optional[bytes]:
        for key, value in (getattr(advertisement_data, "service_data", {}) or {}).items():
            normalized = str(key).replace("-", "").lower()
            if normalized in {"fe95", "0000fe9500001000800000805f9b34fb"}:
                try:
                    return bytes(value)
                except (TypeError, ValueError):
                    return None
        return None

    @staticmethod
    def _format_mac(raw: bytes) -> str:
        return ":".join(f"{part:02X}" for part in raw)

    @classmethod
    def matching_identifiers(cls, advertisement_data) -> Tuple[str, ...]:
        payload = cls._service_payload(advertisement_data)
        if payload is None or len(payload) < 11:
            return ()
        frame_control = int.from_bytes(payload[0:2], "little")
        if not frame_control & cls.FRAME_MAC_INCLUDED:
            return ()
        embedded = payload[5:11]
        # MiBeacon stores the device MAC least-significant byte first on common
        # sensor models. Keep both forms to remain compatible with vendor
        # firmware variants while still requiring an exact registered identity.
        return (
            cls._format_mac(embedded),
            cls._format_mac(bytes(reversed(embedded))),
        )

    @classmethod
    def matches_registered_device(cls, logical_id: str, _device, advertisement_data) -> bool:
        normalized = re.sub(r"[^A-Fa-f0-9]", "", str(logical_id or "")).upper()
        return any(
            re.sub(r"[^A-Fa-f0-9]", "", candidate).upper() == normalized
            for candidate in cls.matching_identifiers(advertisement_data)
        )

    @staticmethod
    def _decode_object(object_id: int, value: bytes) -> dict:
        if object_id == 0x1004 and len(value) == 2:
            return {"ambient_temperature_c": round(int.from_bytes(value, "little", signed=True) / 10.0, 1)}
        if object_id == 0x1006 and len(value) == 2:
            return {"relative_humidity_pct": round(int.from_bytes(value, "little") / 10.0, 1)}
        if object_id == 0x1007 and len(value) == 3:
            return {"illuminance_lux": int.from_bytes(value, "little")}
        if object_id == 0x1008 and len(value) == 1:
            return {"moisture_pct": value[0]}
        if object_id == 0x1009 and len(value) == 2:
            return {"conductivity_us_cm": int.from_bytes(value, "little")}
        if object_id == 0x100A and len(value) == 1 and value[0] <= 100:
            return {"battery_pct": value[0]}
        if object_id == 0x100D and len(value) == 4:
            return {
                "ambient_temperature_c": round(int.from_bytes(value[0:2], "little", signed=True) / 10.0, 1),
                "relative_humidity_pct": round(int.from_bytes(value[2:4], "little") / 10.0, 1),
            }
        return {}

    @classmethod
    def parse_advertisement(cls, _logical_id: str, advertisement_data) -> Optional[dict]:
        payload = cls._service_payload(advertisement_data)
        if payload is None or len(payload) < 5:
            return None

        frame_control = int.from_bytes(payload[0:2], "little")
        if frame_control & cls.FRAME_ENCRYPTED:
            # Bind-key decryption is intentionally a separate future driver;
            # never interpret ciphertext as sensor values.
            return None
        if not frame_control & cls.FRAME_OBJECT_INCLUDED:
            return None

        offset = 5  # frame control + product id + frame counter
        if frame_control & cls.FRAME_MAC_INCLUDED:
            offset += 6
        if frame_control & cls.FRAME_CAPABILITY_INCLUDED:
            if offset >= len(payload):
                return None
            capability = payload[offset]
            offset += 1
            if capability & 0x20:  # I/O capability field follows
                offset += 2

        metrics = {}
        while offset + 3 <= len(payload):
            object_id = int.from_bytes(payload[offset:offset + 2], "little")
            value_length = payload[offset + 2]
            offset += 3
            if value_length == 0 or offset + value_length > len(payload):
                break
            metrics.update(cls._decode_object(object_id, payload[offset:offset + value_length]))
            offset += value_length

        if not metrics:
            return None
        return {
            "provider": cls.PROVIDER,
            "raw_provider": "xiaomi_mibeacon_unencrypted",
            "metrics": metrics,
        }


DRIVER_REGISTRY = SensorDriverRegistry()
for _spec in (
    SensorDriverSpec(
        device_type="wearos",
        display_name="Wear OS Peripheral",
        provider="wear_os",
        mode=DRIVER_MODE_WEAROS,
        priority=10,
    ),
    SensorDriverSpec(
        device_type="jstyle",
        display_name="JStyle / iStyle Watch",
        provider="jstyle",
        mode=DRIVER_MODE_JSTYLE,
        priority=20,
    ),
    SensorDriverSpec(
        device_type="standard_gatt",
        display_name="Standard Bluetooth GATT Health Device",
        provider="standard_gatt",
        mode=DRIVER_MODE_STANDARD_GATT,
        priority=30,
    ),
    SensorDriverSpec(
        device_type="xiaomi_mibeacon",
        display_name="Xiaomi MiBeacon Environmental Sensor",
        provider="xiaomi_mibeacon",
        mode=DRIVER_MODE_ADVERTISEMENT,
        priority=40,
        advertisement_parser=XiaomiMiBeaconDeviceHandler.parse_advertisement,
        advertisement_matcher=XiaomiMiBeaconDeviceHandler.matches_registered_device,
    ),
    SensorDriverSpec(
        device_type="mobile_relay",
        display_name="Mobile / Vendor Relay",
        provider="mobile_relay",
        mode=DRIVER_MODE_EXTERNAL,
        priority=90,
    ),
):
    DRIVER_REGISTRY.register(_spec)
