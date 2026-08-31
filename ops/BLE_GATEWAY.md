# NurseAid BLE gateway sidecar

`ble-gateway` owns Raspberry Pi ↔ ESP32 BLE links. It writes an authoritative
`sensors.json` into the `compose_status` volume. `compose-collector` remains the
only container holding the Central credential and adds that snapshot to its
existing heartbeat.

## Safety behavior

- Before BLE topology is ready, `compose-collector` omits `sensors`; it never
  sends an accidental empty topology during startup.
- A valid ready snapshot, including `{}`, is authoritative.
- If the BLE sidecar stops updating, the collector preserves known identities,
  changes ESP32/watch link status to `unknown`, and advances packet age.
- Malformed BLE notifications do not clear the last valid watch list.
- `reboot_esp32` passes through shared spool files and targets one configured
  sensor only. The BLE container has no IP network and no Central credential.

## ESP32 telemetry contract

The board inventory fields confirmed for NurseAid are:

- `node_id` — logical ESP32 node id, for example `NODE_01`
- `ip` — current IP address reported by the board
- `mac` — MAC address of the ESP32 board
- `jstyle_count` — number of JStyle devices currently connected to this board
- `jstyle_macs[]` — MAC addresses of those currently connected JStyle devices

The preferred payload is one complete UTF-8 JSON document per telemetry frame:

```json
{
  "schemaVersion": 1,
  "node_id": "NODE_01",
  "ip": "192.168.1.100",
  "mac": "84:F7:03:AE:02:94",
  "jstyle_count": 2,
  "jstyle_macs": [
    "10:20:30:40:50:60",
    "AA:BB:CC:DD:EE:FF"
  ]
}
```

`jstyle_count` must exactly match the number of unique valid MAC addresses in
`jstyle_macs`; otherwise the entire frame is rejected and the last valid state
is preserved. NurseAid maps every JStyle MAC in this list to a connected child
entry and derives `connectedJstyleCount` from the validated list. It does not
invent battery, RSSI, packet-loss, or freshness values when the ESP32 does not
report them.

The bridge still accepts the older extended `watches[]` shape for backward
compatibility and test fixtures, but new ESP32 firmware should use the inventory
shape above unless a richer contract is explicitly agreed.

The data fields are now defined, but do not enable real BLE until the firmware
team also confirms notification framing, characteristic UUIDs, stable BLE
identity, reboot payload, and BLE bonding policy. If firmware fragments a JSON
message across notifications, implement and test reassembly before enabling the
real link.

## Configuration

Edit `ops/ble-gateway-config.json`:

```json
{
  "enabled": true,
  "reconnectMaxSeconds": 60,
  "rebootTimeoutSeconds": 45,
  "sensors": [
    {
      "sensorId": "AA:BB:CC:DD:EE:01",
      "address": "AA:BB:CC:DD:EE:01",
      "telemetryCharacteristic": "<confirmed-notify-uuid>",
      "commandCharacteristic": "<confirmed-command-uuid>",
      "rebootPayloadHex": "<confirmed-reboot-opcode-hex>"
    }
  ]
}
```

Then on the host:

```bash
rfkill unblock bluetooth
bluetoothctl power on
docker compose build ble-gateway compose-collector
docker compose up -d ble-gateway compose-collector
docker compose ps ble-gateway compose-collector
docker compose logs --tail=100 ble-gateway compose-collector
```

Keep `enabled: false` until real UUIDs and sensor identities are known. In that
state the sidecar stays healthy but does not modify Central topology.

## Tests

```bash
python3 -m unittest ops/test_ble_gateway.py ops/test_collector_sensors.py
docker compose config --quiet
```
