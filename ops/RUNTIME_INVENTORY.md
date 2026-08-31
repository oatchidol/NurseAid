# NurseAid Raspberry Pi Runtime Inventory

Updated: 2026-08-30 (Asia/Bangkok)

## Target hardware

- Model: Raspberry Pi 3 Model B Rev 1.2
- Architecture: aarch64
- OS: Debian GNU/Linux 13 (trixie)
- Python: 3.13.5
- Node.js: v20.19.2
- BlueZ / bluetoothctl: 5.82
- Docker: 29.7.2
- Docker Compose: v5.5.0

## Radio inventory

- Default Bluetooth controller: `B8:27:EB:E7:96:59`
- Wi-Fi interface: `wlan0`
- Wi-Fi MAC: `B8:27:EB:18:69:A6`
- Current Wi-Fi network: `SS-Device`
- Current Wi-Fi channel: 11 / 2462 MHz / 20 MHz
- No external USB Bluetooth adapter was detected by `lsusb` during this inventory.
- Treat BLE and 2.4 GHz Wi-Fi coexistence as a hardware test requirement before setting the production ESP32-per-Pi capacity.

## Time synchronization

- Timezone: `Asia/Bangkok`
- NTP service: enabled
- `NTPSynchronized=no` at inventory time.

The BLE freshness logic uses monotonic time and therefore does not depend on wall-clock synchronization for elapsed packet age. TLS and certificate validation do depend on correct wall-clock time, so NTP synchronization remains an operational requirement.

## Current NurseAid deployment shape

The existing repository keeps Raspberry Pi agent responsibilities inside `ops/` rather than creating a second standalone repository:

1. `ble-gateway` owns Raspberry Pi ↔ ESP32 BLE links.
2. `ble-gateway` writes an authoritative `sensors.json` snapshot into the shared `compose_status` volume.
3. `compose-collector` reads that snapshot, combines it with host/service health, and is the only component that holds the Central credential.
4. `compose-collector` sends heartbeat/action traffic to NurseAid Central.

This separation intentionally keeps the BLE container on `network_mode: none` and keeps the Central credential out of the BLE process.

## ESP32 managed-device configuration

Managed ESP32 devices are configured in:

- `ops/ble-gateway-config.json`

The file is currently the allowlist/source of truth for managed ESP32 devices. Real BLE must remain disabled until the firmware team confirms the GATT characteristic UUIDs, framing, stable BLE identity, reboot payload, and bonding/security policy.

## Confirmed board inventory fields

Each ESP32 telemetry snapshot can report:

- `node_id`
- `ip`
- `mac` — board MAC
- `jstyle_count`
- `jstyle_macs[]` — MAC addresses of JStyle devices currently connected to that board

`jstyle_count` must equal the number of unique valid entries in `jstyle_macs[]`. The bridge rejects the whole frame on mismatch and preserves the last valid topology.

The shared/Central-facing snapshot exposes the corresponding board metadata as:

- `nodeId`
- `ipAddress`
- `boardMac`
- `connectedJstyleCount`
- `watches[].watchId` for each connected JStyle MAC

## Current verification

- `docker compose config --quiet`: PASS
- Python BLE/collector unit tests: see `ops/test_ble_gateway.py` and `ops/test_collector_sensors.py`

## Remaining hardware gates

- Freeze real ESP32 GATT service/characteristic UUIDs.
- Confirm whether one JSON payload fits in one notification or needs fragmentation/reassembly.
- Confirm stable ESP32 identity if BLE uses a resolvable/private address.
- Measure stable concurrent ESP32 connections on this Raspberry Pi 3 under simultaneous 2.4 GHz Wi-Fi traffic.
- Measure stable JStyle connections per ESP32.
- Confirm BLE bonding/encryption policy.
- Confirm reboot command/ACK behavior.
- Achieve reliable NTP synchronization before relying on outbound TLS in production.
