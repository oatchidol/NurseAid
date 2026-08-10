"""Adaptive Bluetooth adapter selection for the NurseAid BLE gateway.

This module deliberately contains no BlueZ or Bleak I/O. It keeps controller
identity stable by public address, records candidates per controller, and uses
sticky, failure-aware scoring. The gateway owns all hardware operations.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import statistics
import time
from typing import Dict, Iterable, Optional


def normalize_address(value: str) -> str:
    return str(value or "").strip().upper()


def parse_hciconfig_inventory(output: str) -> list["AdapterRuntime"]:
    inventory = []
    interface = None
    for line in str(output or "").splitlines():
        match = __import__("re").match(r"^(hci\d+):", line.strip())
        if match:
            interface = match.group(1)
            continue
        address = __import__("re").search(r"BD Address:\s*([0-9A-Fa-f:]{17})", line)
        if interface and address:
            inventory.append(AdapterRuntime(normalize_address(address.group(1)), interface))
            interface = None
    return inventory


@dataclass
class AdapterRuntime:
    address: str
    interface: str
    powered: bool = True
    healthy: bool = True
    active_connections: int = 0
    active_measurements: int = 0
    recovery_until: float = 0.0


@dataclass
class Candidate:
    device: object
    seen: float
    rssi_samples: list[int] = field(default_factory=list)
    ble_address: str = ""
    local_name: Optional[str] = None
    match_priority: int = 0

    @property
    def median_rssi(self) -> Optional[float]:
        return statistics.median(self.rssi_samples) if self.rssi_samples else None


@dataclass
class Affinity:
    adapter_address: str
    assigned_at: float
    last_success_at: float = 0.0


@dataclass
class DeviceAdapterStats:
    connect_successes: int = 0
    connect_failures: int = 0
    data_successes: int = 0
    empty_cycles: int = 0
    consecutive_connect_failures: int = 0
    consecutive_empty_cycles: int = 0
    gatt_failures: int = 0
    consecutive_gatt_failures: int = 0
    last_failure_at: float = 0.0


class AdaptiveAdapterManager:
    def __init__(
        self,
        adapter_addresses: Iterable[str],
        *,
        affinity_lease_seconds: float = 1800.0,
        switch_margin: float = 25.0,
        max_connections_per_adapter: int = 2,
        max_measurements_per_adapter: int = 1,
    ):
        self.configured_addresses = tuple(
            address for address in (normalize_address(item) for item in adapter_addresses) if address
        )
        self.affinity_lease_seconds = max(0.0, float(affinity_lease_seconds))
        self.switch_margin = max(0.0, float(switch_margin))
        self.max_connections_per_adapter = max(1, int(max_connections_per_adapter))
        self.max_measurements_per_adapter = max(1, int(max_measurements_per_adapter))
        self.adapters: Dict[str, AdapterRuntime] = {}
        self.candidates: Dict[str, Dict[str, Candidate]] = {}
        self.affinities: Dict[str, Affinity] = {}
        self.stats: Dict[str, Dict[str, DeviceAdapterStats]] = {}

    def set_inventory(self, adapters: Iterable[AdapterRuntime]) -> None:
        inventory = {normalize_address(item.address): item for item in adapters}
        if self.configured_addresses:
            inventory = {
                address: item for address, item in inventory.items()
                if address in self.configured_addresses
            }
        self.adapters = inventory

    def record_candidate(
        self,
        logical_id: str,
        adapter_address: str,
        *,
        device: object,
        seen: Optional[float] = None,
        rssi: Optional[int] = None,
        ble_address: str = "",
        local_name: Optional[str] = None,
        match_priority: int = 0,
    ) -> Candidate:
        now = time.time() if seen is None else float(seen)
        address = normalize_address(adapter_address)
        by_adapter = self.candidates.setdefault(logical_id, {})
        candidate = by_adapter.get(address)
        if candidate is None or candidate.ble_address != normalize_address(ble_address):
            candidate = Candidate(device=device, seen=now)
            by_adapter[address] = candidate
        candidate.device = device
        candidate.seen = now
        candidate.ble_address = normalize_address(ble_address)
        candidate.local_name = local_name or candidate.local_name
        candidate.match_priority = max(candidate.match_priority, int(match_priority))
        if rssi is not None:
            candidate.rssi_samples.append(int(rssi))
            del candidate.rssi_samples[:-10]
        return candidate

    def fresh_candidates(self, logical_id: str, max_age: float, now: Optional[float] = None):
        now = time.time() if now is None else float(now)
        return {
            address: candidate
            for address, candidate in self.candidates.get(logical_id, {}).items()
            if address in self.adapters
            and self.adapters[address].powered
            and self.adapters[address].healthy
            and now - candidate.seen <= max_age
        }

    def _stats(self, logical_id: str, adapter_address: str) -> DeviceAdapterStats:
        return self.stats.setdefault(logical_id, {}).setdefault(
            normalize_address(adapter_address), DeviceAdapterStats()
        )

    def record_connect_result(self, logical_id: str, adapter_address: str, success: bool) -> None:
        stats = self._stats(logical_id, adapter_address)
        if success:
            stats.connect_successes += 1
            stats.consecutive_connect_failures = 0
        else:
            stats.connect_failures += 1
            stats.consecutive_connect_failures += 1
            stats.last_failure_at = time.time()

    def record_data_result(self, logical_id: str, adapter_address: str, success: bool) -> None:
        """Record one completed clinical cycle, not individual BLE packets."""
        stats = self._stats(logical_id, adapter_address)
        if success:
            stats.data_successes += 1
            stats.consecutive_empty_cycles = 0
            self.affinities[logical_id] = Affinity(
                normalize_address(adapter_address), time.time(), time.time()
            )
        else:
            stats.empty_cycles += 1
            stats.consecutive_empty_cycles += 1
            stats.last_failure_at = time.time()

    def record_gatt_result(self, logical_id: str, adapter_address: str, success: bool) -> None:
        """Record post-connect transport health separately from clinical data."""
        stats = self._stats(logical_id, adapter_address)
        if success:
            stats.consecutive_gatt_failures = 0
        else:
            stats.gatt_failures += 1
            stats.consecutive_gatt_failures += 1
            stats.last_failure_at = time.time()

    def score(self, logical_id: str, adapter_address: str, candidate: Candidate, now: float) -> float:
        address = normalize_address(adapter_address)
        runtime = self.adapters[address]
        stats = self._stats(logical_id, address)
        rssi = candidate.median_rssi
        signal_score = 0.0 if rssi is None else max(-20.0, min(20.0, (rssi + 75.0) * 1.2))
        score = signal_score
        score += min(30, stats.data_successes * 6)
        score += min(15, stats.connect_successes * 3)
        score -= min(45, stats.consecutive_empty_cycles * 20)
        score -= min(45, stats.consecutive_connect_failures * 15)
        score -= min(45, stats.consecutive_gatt_failures * 20)
        score -= runtime.active_connections * 15
        score -= runtime.active_measurements * 30
        if runtime.recovery_until > now:
            score -= 50
        affinity = self.affinities.get(logical_id)
        if affinity and affinity.adapter_address == address:
            score += 20
        return score

    def choose(self, logical_id: str, max_age: float, now: Optional[float] = None):
        now = time.time() if now is None else float(now)
        candidates = self.fresh_candidates(logical_id, max_age, now)
        candidates = {
            address: candidate for address, candidate in candidates.items()
            if self.adapters[address].active_connections < self.max_connections_per_adapter
        }
        if not candidates:
            return None
        scored = {
            address: self.score(logical_id, address, candidate, now)
            for address, candidate in candidates.items()
        }
        best_address = max(scored, key=lambda address: (scored[address], address))
        affinity = self.affinities.get(logical_id)
        if affinity and affinity.adapter_address in candidates:
            current_score = scored[affinity.adapter_address]
            lease_active = now - affinity.assigned_at < self.affinity_lease_seconds
            current_stats = self._stats(logical_id, affinity.adapter_address)
            affinity_failed = (
                current_stats.consecutive_connect_failures >= 3
                or current_stats.consecutive_empty_cycles >= 2
                or current_stats.consecutive_gatt_failures >= 2
            )
            if not affinity_failed and (
                lease_active or scored[best_address] - current_score < self.switch_margin
            ):
                best_address = affinity.adapter_address
        return best_address, candidates[best_address], scored[best_address]

    def adapter_for_interface(self, interface: str) -> Optional[AdapterRuntime]:
        return next((item for item in self.adapters.values() if item.interface == interface), None)
