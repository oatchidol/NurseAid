"""Authoritative ESP32/JStyle topology built from the public ``ble/esp32`` topic.

Each MQTT message is a full snapshot for one ESP32 board. The registry never
silently deletes a board: a board that stops reporting becomes disconnected and
remains in the topology until an explicit decommission mechanism is added.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

_MAC_RE = re.compile(r"^(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$")
_NODE_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def canonical_mac(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("MAC must be a string")
    text = value.strip()
    if not _MAC_RE.fullmatch(text):
        raise ValueError("invalid MAC address")
    return text.replace("-", ":").upper()


def parse_inventory(payload: object) -> dict:
    """Validate one real ``ble/esp32`` payload and return canonical fields."""
    if not isinstance(payload, dict):
        raise ValueError("ble/esp32 payload must be an object")

    node_id = str(payload.get("node_id") or "").strip()
    if not _NODE_RE.fullmatch(node_id):
        raise ValueError("invalid node_id")

    board_mac = canonical_mac(payload.get("mac"))

    raw_ip = str(payload.get("ip") or "").strip()
    try:
        ip_address = str(ipaddress.ip_address(raw_ip))
    except ValueError as error:
        raise ValueError("invalid ESP32 IP address") from error

    raw_devices = payload.get("devices")
    if not isinstance(raw_devices, list) or len(raw_devices) > 32:
        raise ValueError("devices must be an array with at most 32 MACs")
    devices = [canonical_mac(value) for value in raw_devices]
    if len(set(devices)) != len(devices):
        raise ValueError("duplicate JStyle MAC")

    count = payload.get("count")
    if isinstance(count, bool) or not isinstance(count, int) or not 0 <= count <= 32:
        raise ValueError("count must be an integer from 0 to 32")
    if count != len(devices):
        raise ValueError("count does not match devices")

    result = {
        "nodeId": node_id,
        "boardMac": board_mac,
        "ipAddress": ip_address,
        "devices": devices,
    }
    for source, target, limit in (("time", "reportedTime", 64), ("uuid", "reportUuid", 64)):
        value = str(payload.get(source) or "").strip()
        if value:
            result[target] = value[:limit]
    return result


@dataclass
class BoardState:
    node_id: str
    board_mac: str
    ip_address: str
    devices: tuple[str, ...] = field(default_factory=tuple)
    last_seen_monotonic: float | None = None
    observed_since_start: bool = False


class Esp32TopologyRegistry:
    def __init__(self, path: Path, stale_seconds: int = 90, settle_seconds: int = 30):
        self.path = Path(path)
        self.stale_seconds = max(5, int(stale_seconds))
        self.settle_seconds = max(1, int(settle_seconds))
        self.boards: dict[str, BoardState] = {}
        self.expected_from_cache: set[str] = set()
        self.first_message_monotonic: float | None = None
        self.lock = threading.RLock()
        self._load_cache()

    def _load_cache(self) -> None:
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return
        sensors = value.get("sensors") if isinstance(value, dict) else None
        if not isinstance(sensors, dict):
            return
        for raw_id, raw_sensor in sensors.items():
            try:
                board_mac = canonical_mac(raw_sensor.get("boardMac") or raw_id)
                node_id = str(raw_sensor.get("nodeId") or "").strip()
                ip_address = str(ipaddress.ip_address(str(raw_sensor.get("ipAddress") or "").strip()))
                raw_watches = raw_sensor.get("watches")
                if not _NODE_RE.fullmatch(node_id) or not isinstance(raw_watches, list):
                    continue
                devices = tuple(canonical_mac(watch.get("watchId")) for watch in raw_watches if isinstance(watch, dict))
            except (ValueError, TypeError):
                continue
            self.boards[board_mac] = BoardState(node_id, board_mac, ip_address, devices)
            self.expected_from_cache.add(board_mac)

    def apply(self, payload: object, now_monotonic: float | None = None) -> None:
        parsed = parse_inventory(payload)
        now = time.monotonic() if now_monotonic is None else float(now_monotonic)
        with self.lock:
            if self.first_message_monotonic is None:
                self.first_message_monotonic = now
            board_mac = parsed["boardMac"]
            self.boards[board_mac] = BoardState(
                parsed["nodeId"],
                board_mac,
                parsed["ipAddress"],
                tuple(parsed["devices"]),
                now,
                True,
            )

    def topology_ready(self, now_monotonic: float | None = None) -> bool:
        with self.lock:
            if self.first_message_monotonic is None:
                return False
            now = time.monotonic() if now_monotonic is None else float(now_monotonic)
            if self.expected_from_cache:
                observed = {mac for mac, board in self.boards.items() if board.observed_since_start}
                if self.expected_from_cache.issubset(observed):
                    return True
            return now - self.first_message_monotonic >= self.settle_seconds

    def snapshot(self, now_monotonic: float | None = None) -> dict:
        now = time.monotonic() if now_monotonic is None else float(now_monotonic)
        with self.lock:
            sensors = {}
            for board_mac in sorted(self.boards):
                board = self.boards[board_mac]
                fresh = board.last_seen_monotonic is not None and now - board.last_seen_monotonic <= self.stale_seconds
                status = "connected" if fresh else "disconnected"
                watches = [{"watchId": mac, "status": status} for mac in board.devices]
                last_seen_age = None
                if board.last_seen_monotonic is not None:
                    last_seen_age = max(0, round(now - board.last_seen_monotonic))
                sensors[board_mac] = {
                    "status": status,
                    "nodeId": board.node_id,
                    "ipAddress": board.ip_address,
                    "boardMac": board.board_mac,
                    "connectedJstyleCount": len(board.devices) if fresh else 0,
                    "lastSeenAgeSeconds": last_seen_age,
                    "watches": watches,
                }
            ready = self.topology_ready(now)
        return {
            "schemaVersion": 1,
            "topologyReady": ready,
            "generatedAtEpoch": time.time(),
            "sensors": sensors,
        }

    def write_snapshot(self, now_monotonic: float | None = None) -> None:
        value = self.snapshot(now_monotonic)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o770)
        fd, temporary = tempfile.mkstemp(prefix=".mqtt-topology-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(value, handle, separators=(",", ":"), ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, 0o640)
            os.replace(temporary, self.path)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
