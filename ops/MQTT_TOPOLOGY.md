# MQTT ESP32/JStyle topology

NurseAid currently receives live ESP32 connectivity from the public MQTT topic
`ble/esp32`. This source is preferred by `compose-collector` over the future BLE
GATT sidecar while it is authoritative and fresh.

## Live payload

Observed on the production Raspberry Pi broker on 2026-08-30:

```json
{
  "node_id": "na1c58c",
  "mac": "F0:F5:BD:A1:C5:8C",
  "ip": "172.16.251.32",
  "devices": ["21:02:02:06:9F:7F"],
  "count": 1,
  "time": "2026-08-30 09:45:09",
  "uuid": "2bd3857c-deda-4063-92c8-29cb29ae0d94"
}
```

`devices` is treated as the full set of JStyle watches currently connected to
that ESP32. `count` must exactly match the number of unique MAC addresses in
`devices`; otherwise the whole message is rejected and the last valid state is
kept.

## Snapshot emitted to compose-collector

```json
{
  "topologyReady": true,
  "sensors": {
    "F0:F5:BD:A1:C5:8C": {
      "status": "connected",
      "nodeId": "na1c58c",
      "ipAddress": "172.16.251.32",
      "boardMac": "F0:F5:BD:A1:C5:8C",
      "connectedJstyleCount": 1,
      "watches": [
        {"watchId": "21:02:02:06:9F:7F", "status": "connected"}
      ]
    }
  }
}
```

The MQTT bridge writes this to `/run/nurseaid-compose/mqtt-sensors.json` in the
shared `compose_status` volume. `compose-collector` prefers that file when ready
and falls back to `/run/nurseaid-compose/sensors.json` from `ble-gateway`.

## Freshness and retained topics

- Live `ble/esp32` messages are the source of truth for current connection state.
- A board that stops publishing for `NURSEAID_MQTT_ESP32_STALE_SECONDS` (default
  90 seconds) is retained in topology but marked `disconnected`; its connected
  JStyle count becomes 0.
- On first discovery the bridge waits
  `NURSEAID_MQTT_TOPOLOGY_SETTLE_SECONDS` (default 30 seconds) before making the
  topology authoritative, reducing accidental decommission during staggered
  board discovery.
- Retained topics such as `ble/node/<node_id>/devices` are useful diagnostics but
  are not treated as proof that a watch is connected now. During verification,
  the retained `na1c58c/devices` list contained 3 MACs while the live
  `ble/esp32` snapshot reported only 1 connected watch.

## Security note

The current Mosquitto listener is exposed on port 1883 with
`allow_anonymous true`. Input validation prevents malformed topology from being
accepted, but it does not authenticate the publisher. Before production rollout
across an untrusted/shared hospital network, use authenticated MQTT clients and
ACLs so only approved ESP32 publishers can write `ble/esp32` and related topics.
