# ESP32 Firmware OTA Deploy — Design Spec

Date: 2026-08-28
Status: Approved by user, pending implementation plan

## Context

`server.js` currently publishes patient priority to MQTT (`ble/priority`) which
the ESP32 firmware (`firmware/nurseaid_esp32.ino`) already consumes to adjust
measurement frequency (commit `2aac012`, and the firmware's `applyPriorityList`
around line 644). While confirming that end-to-end, we found the firmware
*also* already supports remote OTA firmware updates:

- **Pull-OTA**: an MQTT command `ota <url>` sent to a node's per-node command
  topic makes the board `httpUpdate.update()` a `.bin` from that URL, flash
  itself, and report progress back over MQTT (`doHttpOta()`, line 747;
  `publishOtaStatus()`, line 735).
- **Push-OTA**: `ArduinoOTA` on port 3232 via `espota.py` — requires being on
  the same LAN/mDNS segment as the board, so it does **not** work from a
  server that isn't on-site. Out of scope for this feature.

`server.js` has **zero** server-side support for triggering pull-OTA: no
`.bin` hosting route, no MQTT publish of an `ota` command, no per-device
firmware version/deployment tracking, no upload UI. This spec covers building
that missing half, surfaced as a new card on the existing `/system-mgmt`
("ระบบ") page, next to the existing "Check for Updates" (app self-update) card.

**Goal:** let an admin upload a compiled `.bin`, pick a device to try it on
first (canary), confirm it succeeded, then roll it out to more devices — all
from the System page, reusing this app's existing patterns (multer uploads,
capability-gated routes, `confirmAction()` modal, `setInterval`+`fetch`
polling) rather than introducing new infrastructure.

## Confirmed firmware-side facts this design depends on

From `firmware/nurseaid_esp32.ino`:

| Constant | Value | Line |
|---|---|---|
| `MQTT_BASE_TOPIC` | `"ble"` | 112 |
| `FW_VERSION` | `"2.1.0"` (compiled-in, reported in OTA status) | 129 |
| `TOPIC_CMD_NODE` (per-node) | `ble/node/<NODE_ID>/cmd` (built at boot, line 1021) | 131, 1021 |
| `TOPIC_CMD_ALL` (broadcast — **not used by this feature**) | `ble/node/all/cmd` | 132 |
| OTA status topic | `ble/node/<NODE_ID>/ota` (`publishOtaStatus`, line 735) | 735 |
| OTA status payload | `{"state":"start\|success\|no_update\|failed","detail":"...","version":"<FW_VERSION>"}` | 735-741 |
| Trigger command format | `"ota <url>"`, url must start with `http://` or `https://` (`handleCommand`, line 883) | 883-889 |

Important caveat: `version` in the OTA status payload is the firmware's
**compiled-in `FW_VERSION` string**, not the admin-typed label from the
upload form (see Data model below). These are independent — if whoever builds
the `.bin` forgets to bump `FW_VERSION` in the source before compiling, the
two won't match. The UI should display both (admin-typed version, and the
`version` reported back once a deployment succeeds) so a mismatch is visible
rather than silently assumed correct.

## Data model

Two new tables (same migration style as `esp32_node_metadata`,
`postgres-init/01-init.sql` + runtime `CREATE TABLE IF NOT EXISTS` in
`server.js`, e.g. around line 964):

```sql
CREATE TABLE IF NOT EXISTS firmware_versions (
    id SERIAL PRIMARY KEY,
    version VARCHAR(40) NOT NULL,          -- admin-typed label, e.g. "1.3.0"
    notes TEXT NOT NULL DEFAULT '',
    filename VARCHAR(255) NOT NULL,        -- server-generated on disk, e.g. fw_7.bin
    file_size INTEGER NOT NULL,
    download_token VARCHAR(64) NOT NULL UNIQUE,  -- random, used in the .bin URL
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS firmware_deployments (
    id SERIAL PRIMARY KEY,
    version_id INTEGER NOT NULL REFERENCES firmware_versions(id),
    board_mac VARCHAR(17) NOT NULL,        -- matches esp32_node_metadata.board_mac
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
        -- pending | start | success | no_update | failed | timeout
    reported_version VARCHAR(40),          -- FW_VERSION from the OTA status payload, once received
    detail TEXT,
    requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    requested_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_firmware_deployments_version ON firmware_deployments(version_id);
```

`firmware_deployments` is both the audit log and the canary gate:
- **"has this version ever been deployed"** = `EXISTS(... WHERE version_id=$1)`
- **"can it go wide"** (canary passed) = `EXISTS(... WHERE version_id=$1 AND status='success')`

## Capability

New capability string `devices:firmware:write`, added only to `super_admin`
in `ROLE_CAPABILITIES` (`server.js:293-306`) — this is a fleet-wide,
hard-to-reverse action (bad firmware can brick a device or knock it offline
mid-shift), so it's more restrictive than plain `devices:write`. Both new
routes below are gated with `requireCapability('devices:firmware:write')`,
following the exact pattern already used for `patients:priority:write` at
`server.js:8524`.

## Upload flow

`POST /api/firmware/upload`, multipart form: `.bin` file + `version` +
`notes` text fields.

- Reuses the notification-sound upload pattern (`server.js:9368-9513`):
  `multer({ storage: multer.memoryStorage(), limits: { fileSize: ... },
  fileFilter: ... })`.
- Whitelist: only `.bin` extension accepted via `fileFilter` (mirroring the
  notification-sound extension whitelist, not trusting client-supplied MIME
  type).
- Size cap: 4 MB (ESP32 app partitions are typically ~1.3–1.9MB; 4MB gives
  headroom without accepting arbitrarily large uploads).
- Stored at `uploads/firmware/<generated-filename>` (same `uploads/`
  directory convention as `NOTIFICATION_SOUND_DIR`, new subfolder;
  `fs.mkdirSync(..., { recursive: true })` at startup like the sound dir).
- Insert one `firmware_versions` row with a fresh random `download_token`
  (e.g. `crypto.randomBytes(24).toString('hex')`).

## Serving the `.bin` to the device

`GET /fw/:token/firmware.bin` — **no capability/session gate**, because the
ESP32's `HTTPUpdate` client can't do cookie/session auth. Security instead
comes from the token being an unguessable, single-purpose random path (not
under `/public`, not linked from anywhere but the deploy trigger itself, not
listable). Looks up the `firmware_versions` row by `download_token`, streams
the file from `uploads/firmware/` with `Content-Type:
application/octet-stream`. A 404 for an unknown/old token is fine — deleting
a `firmware_versions` row (not in scope for v1, but trivial later) naturally
revokes it.

## Deploy flow (canary-gated)

`POST /api/firmware/deploy`, body `{ versionId, targets: ["AA:BB:..", ...] }`,
gated by `devices:firmware:write`:

1. **Server-side canary gate** (enforced in the endpoint itself, not just the
   UI, so it can't be bypassed by calling the API directly): if this
   `versionId` has no prior `firmware_deployments` row with `status='success'`,
   reject the request when `targets.length > 1` with a 400 explaining a
   single-device canary is required first.
2. For each target `board_mac`: resolve `board_mac → nodeId` using the same
   topology data `esp32NodesForUi()` already builds (`server.js:7093-7163`) —
   no new lookup needed, this mapping already exists in memory for the
   esp32-mgmt page.
3. Build the download URL `<origin>/fw/<token>/firmware.bin`, where `<origin>`
   follows the existing convention at `server.js:871`
   (`APP_ORIGIN || \`${req.protocol}://${req.get('host')}\``) — reused as-is,
   no new config needed.
4. Publish MQTT `ota <url>` to that node's **per-node** topic
   (`ble/node/<nodeId>/cmd`) — deliberately never `TOPIC_CMD_ALL`
   (`ble/node/all/cmd`), so a single deploy call can never accidentally reach
   every node even if `targets` were mis-built.
5. Insert a `firmware_deployments` row per target with `status='pending'`.

## Status feedback

New MQTT subscription in `initMqttClient()` (alongside the existing `ble/mac`,
`ble/priority` handling) to the wildcard topic `ble/node/+/ota`. On message:
extract `NODE_ID` from the topic, parse the JSON payload
(`{state, detail, version}`), map `state` → `firmware_deployments.status`
(`start`/`success`/`no_update`/`failed` pass through as-is), store `version`
into `reported_version`, and update the most recent
`pending`/`start` deployment row for that node's `board_mac`.

`GET /api/firmware/deployments?versionId=` returns current rows for that
version (mac, status, detail, reported_version, timestamps). Frontend polls
this every 3 seconds — matching this app's existing convention (`setInterval`
+ `fetch`, e.g. `loadReceivers()` at `server.js:7413-7468` polling every 5s;
no SSE/WebSocket exists anywhere in this app, confirmed by grep, so this
feature won't introduce one) — while any row for that version is
`pending`/`start`, with a `receiverLoading`-style re-entrancy guard, and stops
polling once every targeted row reaches a terminal state.

## UI — new card on `/system-mgmt`

Placed below the existing "เวอร์ชันปัจจุบัน / ตรวจสอบอัปเดต" card
(`server.js:11087-11127`), titled "อัปเดตเฟิร์มแวร์ ESP32":

1. **Upload form** — file input (`.bin`), version text input, notes textarea,
   submit button.
2. **Version list** — each uploaded version showing: version label, notes,
   upload date, and a canary-state badge (untested / canary running / canary
   passed).
3. **Device picker**, per selected version — sourced from the same
   `/api/esp32-nodes` data the esp32-mgmt page already fetches (so it shows
   online/offline status and the patient/bed context already resolved there,
   not a bare MAC list). **Locked to single-select** until that version has a
   successful canary deployment; multi-select unlocks after.
4. **Confirmation** reuses the existing `confirmAction()` modal
   (`server.js:4291`) rather than building a new confirmation UI.
5. **Live status** for an in-flight deploy: polls `/api/firmware/deployments`
   as described above, shows per-device state.

## Explicitly out of scope for this version

- Building `.bin` from `.ino` source server-side (no `arduino-cli`/PlatformIO
  installed on this machine — confirmed; a separate, much larger effort).
- `TOPIC_CMD_ALL` broadcast deploys — every deploy call targets specific
  per-node topics only, even for a "select all" UI action (loop over targets
  server-side, one per-node publish each — never the `_ALL` topic).
- Automatic rollback if a device fails to come back online after an update
  (the firmware already avoids bricking — `HTTP_UPDATE_OK` only reboots after
  a fully verified flash, and any other outcome leaves the old firmware
  intact per `doHttpOta()`'s own comments) — but the UI does not attempt any
  automated recovery action, only visibility into `failed`/`timeout` status.
- Deleting/pruning old `firmware_versions` rows and their files.
