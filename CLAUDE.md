# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NurseAid is a hospital patient monitoring system running on a Raspberry Pi 5. It ingests BLE wearable telemetry via ESP32 gateways, stores vitals in InfluxDB (time-series) and PostgreSQL (relational), runs an alert engine, and serves a real-time monitoring UI. An optional AI chat assistant routes questions to either live-vitals analysis or general conversation.

## Commands

```bash
# Syntax check only (fast, no DB/MQTT required)
node --check server.js

# Run all JS unit tests that don't need a live server
npm run test:or-patients
npm run test:ai-chat-logic
npm run test:esp32-node-status

# Full test suite (requires running Postgres + InfluxDB + MQTT)
npm test

# Build CSS from Tailwind input
npm run build:css

# Check that all offline UI assets are present
npm run check:assets

# Start the app directly (for local debugging)
SESSION_SECRET=<32+ char secret> node server.js
```

Python tests live in subdirectories and use their own venvs:
```bash
cd mqtt-bridge && python -m unittest test_mqtt_bridge
cd ops && python -m unittest test_ble_gateway test_collector_sensors
```

## Architecture

### Service topology (Docker Compose)

```
nginx (:443) → nurseaid app (:3333) ← PostgreSQL (:5432)
                                    ← InfluxDB (:8086)
                                    ← Mosquitto MQTT (:1883)
mqtt-bridge (Python) → Mosquitto → InfluxDB
ble-gateway (Python, no network) → BlueZ → writes compose_status volume
compose-collector (Python) → reads host Docker stats → writes compose_status + apply_update spool
```

The app (`server.js`) is the only Node.js process. It connects to PostgreSQL for users/patients/alerts/devices, InfluxDB for vitals time-series, and Mosquitto for device heartbeats and OTA status.

### Key modules (all in repo root)

| File | Role |
|------|------|
| `server.js` (~12.9k lines) | Single-file Express 5 app: routes, auth, alert engine, AI chat, firmware OTA, all UI templates |
| `live-status.js` | Builds the live-vitals snapshot from InfluxDB entries with per-metric freshness policies |
| `esp32-status.js` | Parses the ESP32 topology JSON written by compose-collector; canonicalises MAC addresses |
| `or-patients.js` | Fetches and validates patient census data from the hospital HIS (OR Patient API) |

### Auth model

- JWT session cookie (`nurseaid_session`) signed with `SESSION_SECRET` (≥32 chars, required at startup).
- Role-based capability check via `requireCapability(...caps)` middleware. Roles: `super_admin`, `ward_admin`, `staff_nurse`, `viewer`.
- Capabilities follow the pattern `resource:action` (e.g. `devices:write`, `patients:priority:write`, `alerts:settings:write`).
- `adminOnly` is a deprecated alias for `requireCapability('settings:global')`; prefer explicit capability calls.

### Data flow for live vitals

1. ESP32 gateway publishes heart rate / SpO₂ / temperature to MQTT topics (`ble/node/<id>/heart`, etc.).
2. `mqtt-bridge` (Python) writes measurements to InfluxDB.
3. `compose-collector` writes device topology to `/run/nurseaid-compose/mqtt-sensors.json`.
4. `server.js` reads the topology file, queries InfluxDB with freshness-aware windows (`LIVE_FRESHNESS_POLICY`), and serves `/api/live-status`.

Freshness is per-metric: clinical (600s), status (180s), battery (1800s), presence/RSSI (90s), live HR (30s). Configurable via `LIVE_*_FRESHNESS_SECONDS` env vars.

### AI chat routing

`classifyAiQuestion(question, patientKey)` in `server.js` routes to either:
- `monitor_analysis` — asks the AI about a specific patient's vitals (requires a selected patient bed)
- `conversation` — general medical knowledge or chitchat

The function uses keyword heuristics; there is a deliberate trade-off documented in-code where off-topic questions with a patient selected still route to analysis. See the `looksLikeContinuation` comment in the source.

### Firmware OTA

- Upload `.bin` files via `POST /api/firmware/upload` → stored on disk, token generated.
- Serve via `GET /fw/:token/firmware.bin` (requires `Content-Length` header).
- Deploy to ESP32 nodes via MQTT (`ble/node/<id>/ota`) with status callbacks handled in `handleOtaStatusMessage`.
- Version metadata is persisted in PostgreSQL; edit/delete endpoints exist.

### Version tracking

`APP_VERSION` is read from `package.json` at startup — never hard-code a version string in the UI or routes. Grep for `v${APP_VERSION}` before adding new badges.

## Testing notes

- Tests that `require('../server.js')` need `SESSION_SECRET` set to ≥32 characters, or server.js throws at load time. The package.json scripts set this automatically; run them via `npm run test:*` rather than invoking `node --test` directly on those files.
- `test/test_or_patients.js` is a pure unit test — no env vars needed.
- `test/test_ai_chat_logic.js` and `test/test_esp32_node_status.js` import server.js for exported helpers only; they need `SESSION_SECRET` but do not start the DB/MQTT stack (the `require.main === module` guard prevents `startServer()`).
- The full `npm test` also runs `test_wards_mgmt.js` and `test_monitor_ai_chat.js` which connect to a live database — those require the Docker Compose stack to be running.

## Environment variables (key ones)

| Variable | Default | Notes |
|----------|---------|-------|
| `SESSION_SECRET` | *(required)* | ≥32 chars; app refuses to start otherwise |
| `PORT` | 3333 | App listen port |
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | — | PostgreSQL connection |
| `INFLUX_URL`, `INFLUX_TOKEN`, `INFLUX_ORG`, `INFLUX_BUCKET` | — | InfluxDB connection |
| `MQTT_HOST`, `MQTT_PORT`, `MQTT_USER`, `MQTT_PASSWORD` | — | Mosquitto broker |
| `AI_CHAT_ENABLED` | false | Set `true` to enable the AI assistant |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | — | OpenAI-compatible endpoint config |
| `OR_PATIENT_API_BASE_URL` | — | Hospital HIS patient census API |
| `LIVE_VITAL_FRESHNESS_SECONDS` | 600 | Query window for clinical metrics |
| `ALERT_ENGINE_INTERVAL_MS` | 15000 | How often the alert engine ticks |

See `.env.example` for the full reference. Never commit a real `.env`.

## Code style & conventions

- `server.js` is intentionally a single file — it is the deployable unit. Do not split it into a framework of small modules unless there is a clear maintenance reason.
- All routes are defined in `server.js`; there is no router-per-file pattern.
- SQL migrations and schema changes go in `postgres-init/01-init.sql` (run once on empty DB) plus any ad-hoc `ALTER TABLE` statements inside `startServer()` for rolling updates.
- UI assets (CSS, JS, fonts) are committed pre-built in `public/assets/`. Edit `src/tailwind-input.css` and run `npm run build:css` to regenerate.
- The app runs as non-root user `appuser` (UID 100, GID 101) inside the container. Volume mounts for uploads are pre-chowned to this UID/GID in the Dockerfile.
