#!/usr/bin/env python3
"""BLE sidecar: many ESP32 devices -> one authoritative sensors snapshot.

The compose collector remains the only component that authenticates to
NurseAid Central. This process talks only to BlueZ and the shared spool.
"""
import asyncio
import ipaddress
import json
import os
import re
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path


CONFIG_FILE = Path(os.getenv("NURSEAID_BLE_CONFIG", "/etc/nurseaid/ble-gateway.json"))
SPOOL_DIR = Path(os.getenv("NURSEAID_BLE_SPOOL", "/run/nurseaid-compose"))
STATUS_FILE = SPOOL_DIR / "sensors.json"
MAX_NOTIFY_BYTES = 65536
VALID_STATUS = {"connected", "disconnected", "unknown"}
SENSOR_ID_RE = re.compile(r"^[A-Za-z0-9:_-]{1,40}$")
ACTION_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def log(event, **details):
    print(json.dumps({"event": event, **details}, separators=(",", ":")), flush=True)


def canonical_sensor_id(value):
    text = str(value).strip()
    if not SENSOR_ID_RE.fullmatch(text):
        raise ValueError("invalid sensor identity")
    compact = re.sub(r"[:-]", "", text)
    if re.fullmatch(r"[0-9A-Fa-f]{12}", compact):
        compact = compact.upper()
        return ":".join(compact[index:index + 2] for index in range(0, 12, 2))
    return text.upper()


def canonical_mac(value, field_name="mac"):
    compact = re.sub(r"[:-]", "", str(value or "").strip())
    if not re.fullmatch(r"[0-9A-Fa-f]{12}", compact):
        raise ValueError(f"{field_name} invalid")
    compact = compact.upper()
    return ":".join(compact[index:index + 2] for index in range(0, 12, 2))


def canonical_ip(value):
    text = str(value or "").strip()
    if not text:
        raise ValueError("ip invalid")
    try:
        return str(ipaddress.ip_address(text))
    except ValueError as error:
        raise ValueError("ip invalid") from error


def bounded_number(value, minimum, maximum, decimals=0, field_name="value"):
    """Validate an optional numeric telemetry field without fabricating defaults."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise ValueError(f"{field_name} must be numeric")
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field_name} must be numeric") from error
    if not minimum <= number <= maximum:
        raise ValueError(f"{field_name} out of range")
    rounded = round(number, decimals)
    return int(rounded) if decimals == 0 else rounded


@dataclass(frozen=True)
class SensorConfig:
    sensor_id: str
    address: str
    telemetry_characteristic: str
    command_characteristic: str
    reboot_payload: bytes


@dataclass
class WatchState:
    watch_id: str
    status: str
    battery_percent: int | None
    rssi_dbm: int | None
    packet_loss_percent: float | None
    packet_age: int | None
    observed_monotonic: float

    def snapshot(self, now):
        result = {"watchId": self.watch_id, "status": self.status}
        values = {
            "batteryPercent": self.battery_percent,
            "rssiDbm": self.rssi_dbm,
            "packetLossPercent": self.packet_loss_percent,
        }
        result.update({key: value for key, value in values.items() if value is not None})
        if self.packet_age is not None:
            age = self.packet_age + max(0, round(now - self.observed_monotonic))
            if age <= 86400:
                result["lastPacketAgeSeconds"] = age
        return result


@dataclass
class SensorState:
    status: str = "unknown"
    node_id: str = ""
    ip_address: str = ""
    board_mac: str = ""
    firmware_version: str = ""
    watches: dict = field(default_factory=dict)
    connection_generation: int = 0
    telemetry_generation: int = 0


def load_config(path=CONFIG_FILE):
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("BLE config root must be an object")
    enabled = raw.get("enabled") is True
    reconnect_max = max(5, min(600, int(raw.get("reconnectMaxSeconds", 60))))
    reboot_timeout = max(5, min(300, int(raw.get("rebootTimeoutSeconds", 45))))
    raw_sensors = raw.get("sensors", [])
    if not isinstance(raw_sensors, list) or len(raw_sensors) > 16:
        raise ValueError("sensors must be an array with at most 16 entries")
    sensors = []
    seen = set()
    for index, item in enumerate(raw_sensors):
        if not isinstance(item, dict):
            raise ValueError(f"sensors[{index}] must be an object")
        sensor_id = canonical_sensor_id(item.get("sensorId", ""))
        if sensor_id in seen:
            raise ValueError(f"duplicate sensorId: {sensor_id}")
        seen.add(sensor_id)
        address = str(item.get("address") or "").strip()
        telemetry = str(item.get("telemetryCharacteristic") or "").strip()
        command = str(item.get("commandCharacteristic") or "").strip()
        reboot_hex = str(item.get("rebootPayloadHex") or "").strip()
        if not address or not telemetry:
            raise ValueError(f"address and telemetryCharacteristic are required for {sensor_id}")
        try:
            reboot_payload = bytes.fromhex(reboot_hex) if reboot_hex else b""
        except ValueError as error:
            raise ValueError(f"invalid rebootPayloadHex for {sensor_id}") from error
        sensors.append(SensorConfig(sensor_id, address, telemetry, command, reboot_payload))
    if enabled and not sensors:
        raise ValueError("enabled BLE gateway requires at least one managed sensor")
    return enabled, reconnect_max, reboot_timeout, tuple(sensors)


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o770)
    fd, name = tempfile.mkstemp(prefix=".ble-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, separators=(",", ":"), ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(name, 0o640)
        os.replace(name, path)
    finally:
        try:
            os.unlink(name)
        except FileNotFoundError:
            pass


class Gateway:
    def __init__(self, enabled, reconnect_max, reboot_timeout, sensors, client_factory=None):
        self.enabled = enabled
        self.reconnect_max = reconnect_max
        self.reboot_timeout = reboot_timeout
        self.client_factory = client_factory
        self.sensors = {sensor.sensor_id: sensor for sensor in sensors}
        self.states = {sensor.sensor_id: SensorState() for sensor in sensors}
        self.clients = {}
        self.lock = asyncio.Lock()
        self.changed = asyncio.Condition(self.lock)
        self.topology_ready = False
        self.reconciled_sensors = set()
        self.stop = asyncio.Event()
        self.command_tasks = set()

    def _mark_reconciled_locked(self, sensor_id):
        self.reconciled_sensors.add(sensor_id)
        if self.enabled and len(self.reconciled_sensors) == len(self.sensors):
            self.topology_ready = True

    async def mark_connected(self, sensor_id, client):
        async with self.changed:
            state = self.states[sensor_id]
            state.status = "connected"
            state.connection_generation += 1
            self.clients[sensor_id] = client
            self._mark_reconciled_locked(sensor_id)
            self.changed.notify_all()

    async def mark_disconnected(self, sensor_id):
        async with self.changed:
            self.states[sensor_id].status = "disconnected"
            self.clients.pop(sensor_id, None)
            self._mark_reconciled_locked(sensor_id)
            self.changed.notify_all()

    async def apply_telemetry(self, sensor_id, payload):
        if sensor_id not in self.states:
            raise ValueError("telemetry from unmanaged sensor")
        if not isinstance(payload, dict) or payload.get("schemaVersion") != 1:
            raise ValueError("unsupported telemetry schema")
        if "sensorId" in payload and canonical_sensor_id(payload["sensorId"]) != sensor_id:
            raise ValueError("telemetry sensorId mismatch")

        now = time.monotonic()
        watches = {}
        node_id = ""
        ip_address = ""
        board_mac = ""

        # Confirmed minimal ESP32 inventory contract used by the board UI:
        # node_id, ip, mac, jstyle_count and jstyle_macs[].  The bridge converts
        # each connected JStyle MAC into one connected watch entry for Central.
        if "jstyle_macs" in payload:
            node_id = str(payload.get("node_id") or "").strip()
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", node_id):
                raise ValueError("node_id invalid")
            ip_address = canonical_ip(payload.get("ip"))
            board_mac = canonical_mac(payload.get("mac"), "mac")

            configured_compact = re.sub(r"[:-]", "", sensor_id)
            if re.fullmatch(r"[0-9A-Fa-f]{12}", configured_compact):
                if canonical_mac(sensor_id, "sensorId") != board_mac:
                    raise ValueError("board mac does not match managed sensorId")

            raw_macs = payload.get("jstyle_macs")
            if not isinstance(raw_macs, list) or len(raw_macs) > 32:
                raise ValueError("jstyle_macs must be an array with at most 32 entries")
            raw_count = payload.get("jstyle_count")
            if isinstance(raw_count, bool) or not isinstance(raw_count, int) or not 0 <= raw_count <= 32:
                raise ValueError("jstyle_count invalid")
            if raw_count != len(raw_macs):
                raise ValueError("jstyle_count does not match jstyle_macs")

            for index, raw_mac in enumerate(raw_macs):
                watch_id = canonical_mac(raw_mac, f"jstyle_macs[{index}]")
                if watch_id in watches:
                    raise ValueError(f"duplicate JStyle MAC: {watch_id}")
                watches[watch_id] = WatchState(
                    watch_id, "connected", None, None, None, None, now,
                )
        else:
            # Backward-compatible extended telemetry shape. Optional health
            # values remain supported, but they are never fabricated when the
            # ESP32 only reports connection inventory.
            raw_watches = payload.get("watches")
            if not isinstance(raw_watches, list):
                raise ValueError("watches must be an array")
            if len(raw_watches) > 32:
                raise ValueError("more than 32 watches")

            for index, item in enumerate(raw_watches):
                if not isinstance(item, dict):
                    raise ValueError(f"watches[{index}] must be an object")

                watch_id = str(item.get("watchId") or "").strip()
                if not watch_id or len(watch_id) > 64:
                    raise ValueError(f"watches[{index}].watchId invalid")
                if watch_id in watches:
                    raise ValueError(f"duplicate watchId: {watch_id}")

                status = item.get("status")
                if status not in VALID_STATUS:
                    raise ValueError(f"watches[{index}].status invalid")

                watches[watch_id] = WatchState(
                    watch_id,
                    status,
                    bounded_number(item.get("batteryPercent"), 0, 100, field_name="batteryPercent"),
                    bounded_number(item.get("rssiDbm"), -120, 0, field_name="rssiDbm"),
                    bounded_number(item.get("packetLossPercent"), 0, 100, 1, "packetLossPercent"),
                    bounded_number(item.get("lastPacketAgeSeconds"), 0, 86400, field_name="lastPacketAgeSeconds"),
                    now,
                )

        firmware = str(payload.get("firmwareVersion") or "").strip()
        if len(firmware) > 40:
            raise ValueError("firmwareVersion too long")

        async with self.changed:
            # Full snapshots are applied atomically only after the whole frame validates.
            # This prevents one malformed child from silently retiring a previously valid watch.
            state = self.states[sensor_id]
            state.status = "connected"
            if node_id:
                state.node_id = node_id
            if ip_address:
                state.ip_address = ip_address
            if board_mac:
                state.board_mac = board_mac
            state.firmware_version = firmware or state.firmware_version
            state.watches = watches
            state.telemetry_generation += 1
            self._mark_reconciled_locked(sensor_id)
            self.changed.notify_all()

    async def notify(self, sensor_id, data):
        if not data or len(data) > MAX_NOTIFY_BYTES:
            log("ble_notify_rejected", sensorId=sensor_id, reason="invalid_length", size=len(data))
            return
        try:
            payload = json.loads(bytes(data).decode("utf-8"))
            await self.apply_telemetry(sensor_id, payload)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            log("ble_notify_rejected", sensorId=sensor_id, reason=type(error).__name__)

    async def sensor_worker(self, sensor):
        if self.client_factory is None:
            from bleak import BleakClient
            client_factory = BleakClient
        else:
            client_factory = self.client_factory

        delay = 1
        while not self.stop.is_set():
            client = client_factory(sensor.address, timeout=15)
            try:
                await client.connect()
                await self.mark_connected(sensor.sensor_id, client)

                def callback(_characteristic, data):
                    task = asyncio.create_task(self.notify(sensor.sensor_id, data))
                    self.command_tasks.add(task)
                    task.add_done_callback(self.command_tasks.discard)

                await client.start_notify(sensor.telemetry_characteristic, callback)
                log("ble_connected", sensorId=sensor.sensor_id)
                delay = 1
                while client.is_connected and not self.stop.is_set():
                    await asyncio.sleep(1)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                log("ble_connection_failed", sensorId=sensor.sensor_id, error=type(error).__name__)
            finally:
                await self.mark_disconnected(sensor.sensor_id)
                try:
                    if client.is_connected:
                        await client.disconnect()
                except Exception:
                    pass
            if not self.stop.is_set():
                await asyncio.sleep(delay)
                delay = min(self.reconnect_max, delay * 2)

    async def state_writer(self):
        while not self.stop.is_set():
            async with self.lock:
                now = time.monotonic()
                sensors = {}
                for sensor_id in sorted(self.states):
                    state = self.states[sensor_id]
                    item = {"status": state.status, "watches": [
                        state.watches[watch_id].snapshot(now) for watch_id in sorted(state.watches)
                    ]}
                    item["connectedJstyleCount"] = sum(
                        watch.status == "connected" for watch in state.watches.values()
                    )
                    if state.node_id:
                        item["nodeId"] = state.node_id
                    if state.ip_address:
                        item["ipAddress"] = state.ip_address
                    if state.board_mac:
                        item["boardMac"] = state.board_mac
                    if state.firmware_version:
                        item["firmwareVersion"] = state.firmware_version
                    sensors[sensor_id] = item
                output = {
                    "schemaVersion": 1,
                    "topologyReady": self.topology_ready,
                    "generatedAt": datetime.now(timezone.utc).isoformat(),
                    "sensors": sensors,
                }
            await asyncio.to_thread(atomic_json, STATUS_FILE, output)
            await asyncio.sleep(3)

    async def execute_reboot(self, request_path, response_path, value):
        action_id = str(value.get("actionId") or "")
        sensor_id = canonical_sensor_id(value.get("sensorId", ""))
        try:
            expires = datetime.fromisoformat(str(value.get("expiresAt") or "").replace("Z", "+00:00"))
            if expires <= datetime.now(timezone.utc):
                raise RuntimeError("action expired before BLE execution")
            sensor = self.sensors.get(sensor_id)
            if sensor is None:
                raise RuntimeError("ESP32 target is not managed")
            if not sensor.command_characteristic or not sensor.reboot_payload:
                raise RuntimeError("reboot command is not configured for this ESP32")
            async with self.lock:
                client = self.clients.get(sensor_id)
                state = self.states[sensor_id]
                connection_before = state.connection_generation
                telemetry_before = state.telemetry_generation
            if client is None or not client.is_connected:
                raise RuntimeError("ESP32 target is not connected")
            await client.write_gatt_char(sensor.command_characteristic, sensor.reboot_payload, response=True)

            async def reconnected():
                async with self.changed:
                    await self.changed.wait_for(lambda: (
                        self.states[sensor_id].connection_generation > connection_before
                        and self.states[sensor_id].telemetry_generation > telemetry_before
                    ))
            await asyncio.wait_for(reconnected(), timeout=self.reboot_timeout)
            result = {
                "actionId": action_id,
                "status": "succeeded",
                "result": {"rebooted": True, "mac": sensor_id, "acknowledged": True},
            }
        except Exception as error:
            result = {
                "actionId": action_id,
                "status": "failed",
                "error": str(error)[:500] or type(error).__name__,
                "result": {"rebooted": False, "mac": sensor_id},
            }
        await asyncio.to_thread(atomic_json, response_path, result)
        request_path.unlink(missing_ok=True)

    async def command_worker(self):
        while not self.stop.is_set():
            for path in list(SPOOL_DIR.glob("*.ble-request.json"))[:2]:
                action_id = path.name.removesuffix(".ble-request.json")
                response_path = SPOOL_DIR / f"{action_id}.ble-response.json"
                if response_path.exists() or any(task.get_name() == action_id for task in self.command_tasks):
                    continue
                try:
                    value = json.loads(path.read_text(encoding="utf-8"))
                    if not ACTION_ID_RE.fullmatch(action_id) or value.get("action") != "reboot_esp32":
                        path.unlink(missing_ok=True)
                        continue
                    task = asyncio.create_task(self.execute_reboot(path, response_path, value), name=action_id)
                    self.command_tasks.add(task)
                    task.add_done_callback(self.command_tasks.discard)
                except (OSError, ValueError, json.JSONDecodeError):
                    path.unlink(missing_ok=True)
            await asyncio.sleep(1)

    async def run(self):
        writer = asyncio.create_task(self.state_writer())
        commands = asyncio.create_task(self.command_worker())
        workers = []
        if self.enabled:
            workers = [asyncio.create_task(self.sensor_worker(sensor)) for sensor in self.sensors.values()]
        else:
            log("ble_gateway_disabled", config=str(CONFIG_FILE))
        try:
            await asyncio.gather(writer, commands, *workers)
        finally:
            self.stop.set()
            for task in (writer, commands, *workers, *tuple(self.command_tasks)):
                task.cancel()
            await asyncio.gather(writer, commands, *workers, *tuple(self.command_tasks), return_exceptions=True)


def main():
    enabled, reconnect_max, reboot_timeout, sensors = load_config()
    log("ble_gateway_started", enabled=enabled, sensors=len(sensors))
    asyncio.run(Gateway(enabled, reconnect_max, reboot_timeout, sensors).run())


if __name__ == "__main__":
    main()
