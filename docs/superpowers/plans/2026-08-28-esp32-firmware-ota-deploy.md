# ESP32 Firmware OTA Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin upload a compiled ESP32 `.bin`, deploy it to a single "canary" device first, and only then unlock deploying it to more devices — all from a new card on the existing `/system-mgmt` page.

**Architecture:** Everything lives in `server.js` (this codebase is a single-file monolith; new features are added as new route blocks + a `tables` array entry + a `module.exports` addition, not new files/modules — matching every existing feature). The firmware side (`firmware/nurseaid_esp32.ino`) already fully supports the receiving end (MQTT `ota <url>` command → HTTP-pull → self-flash → MQTT status report); this plan only builds the missing server half.

**Tech Stack:** Node.js/Express, `pg` (Postgres), `mqtt` (npm package — already used, server only *publishes* today, this plan adds its first *subscribe*), `multer` (already used elsewhere), `node:test` + `node:assert/strict` (this repo's only test tooling — no supertest, no route-level HTTP tests anywhere in the codebase; only pure functions get automated tests, exported via `module.exports` at the bottom of `server.js` exactly like `classifyAiQuestion`, `parseSemver`, etc. are today).

**Spec:** `docs/superpowers/specs/2026-08-28-esp32-firmware-ota-deploy-design.md`

## Global Constraints

- New capability `devices:firmware:write` gates every new admin-facing route; only `super_admin` gets it (spec: "Capability" section).
- `.bin` upload: extension whitelist `.bin` only, 4 MB size cap (spec: "Upload flow").
- The `.bin` is served at an unguessable per-version token URL (`GET /fw/:token/firmware.bin`), with **no** capability/session gate — the ESP32's `HTTPUpdate` client can't authenticate (spec: "Serving the .bin to the device").
- Deploy always publishes to the **per-node** topic `ble/node/<nodeId>/cmd` — **never** `ble/node/all/cmd` (spec: "Deploy flow", "Explicitly out of scope").
- Canary gate is enforced **server-side**, inside the deploy endpoint itself, not only in the UI: a version with no prior `status='success'` deployment row may only be deployed to exactly 1 target at a time (spec: "Deploy flow").
- No SSE/WebSocket — status UI polls via `setInterval` + `fetch`, matching every other "live" view in this app (spec: "Status feedback"; confirmed nothing else in `server.js` uses SSE/WebSocket).
- Follow existing code conventions exactly: `multer.memoryStorage()` uploads (see `server.js:9479-9513`), template-literal SQL added to the `tables` array in `initDatabase()` (`server.js:900-1019`), routes gated with `requireCapability(...)` (`server.js:321-329`), `ui(user, active, content, script)` for page rendering (`server.js:2040`), `confirmAction()` for destructive-action confirmation (`server.js:4291`), `escapeHTML()`/`statusIcon()` helpers already used by the neighboring "Check for Updates" UI (`server.js:11149-11216`).
- Every step that touches `server.js` must be verified with `node --check server.js` (this is literally what `npm test` runs first — `package.json:6`) — there is no dev server smoke-test tooling in this environment, so syntax-checking plus the pure-function unit tests are the automated safety net; anything requiring a live Postgres/MQTT broker/browser is called out as a manual verification step instead of an automated test, matching how the rest of this codebase is tested today.

---

### Task 1: Database tables + capability string
**Status:** ✅ Done — commit `9dabb76`

**Files:**
- Modify: `server.js:1019` (end of the `tables` array in `initDatabase()`, right after the `esp32_node_metadata` entry)
- Modify: `server.js:296` (super_admin's capability `Set` in `ROLE_CAPABILITIES`)
- Modify: `server.js:12097-12108` (`module.exports`, to add `roleHasCapability` — needed by Task 1's test and reused by later route tasks)
- Test: `test/test_firmware_ota.js` (new file — this task creates it; later tasks append to it)

**Interfaces:**
- Produces: `roleHasCapability(role, cap)` now exported from `server.js` for tests (already existed internally at `server.js:308`; only the export is new).
- Produces (schema): `firmware_versions(id, version, notes, filename, file_size, download_token, uploaded_by, uploaded_at)` and `firmware_deployments(id, version_id, board_mac, status, reported_version, detail, requested_by, requested_at, updated_at)`.

- [x] **Step 1: Add the two tables to the `initDatabase()` array**

Find the `esp32_node_metadata` entry inside the `tables` array (`server.js`, inside `initDatabase()`) and add two entries directly after it:

```js
    `CREATE TABLE IF NOT EXISTS firmware_versions (
        id SERIAL PRIMARY KEY,
        version VARCHAR(40) NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        filename VARCHAR(255) NOT NULL,
        file_size INTEGER NOT NULL,
        download_token VARCHAR(64) NOT NULL UNIQUE,
        uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        uploaded_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS firmware_deployments (
        id SERIAL PRIMARY KEY,
        version_id INTEGER NOT NULL REFERENCES firmware_versions(id),
        board_mac VARCHAR(17) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        reported_version VARCHAR(40),
        detail TEXT,
        requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        requested_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_firmware_deployments_version ON firmware_deployments(version_id)`,
```

- [x] **Step 2: Add the capability string**

In `ROLE_CAPABILITIES.super_admin`'s `Set`, append `'devices:firmware:write'` to the last line of its array (the one ending `...,'audit:read:all','export:read'`), making it `...,'audit:read:all','export:read','devices:firmware:write'`. Do **not** add it to `ward_admin`, `staff_nurse`, or `viewer`.

- [x] **Step 3: Export `roleHasCapability` for tests**

In the `module.exports` block at the bottom of `server.js`, add `roleHasCapability` to the list (alongside `parseSemver`, `compareSemver`, etc.).

- [x] **Step 4: Write the failing test**

Create `test/test_firmware_ota.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { roleHasCapability } = require('../server.js');

test('devices:firmware:write is granted only to super_admin', () => {
    assert.equal(roleHasCapability('super_admin', 'devices:firmware:write'), true);
    assert.equal(roleHasCapability('ward_admin', 'devices:firmware:write'), false);
    assert.equal(roleHasCapability('staff_nurse', 'devices:firmware:write'), false);
    assert.equal(roleHasCapability('viewer', 'devices:firmware:write'), false);
});
```

- [x] **Step 5: Run test to verify it fails**

Run: `SESSION_SECRET=test-secret-please-change-me-32chars node --test test/test_firmware_ota.js`
Expected: FAIL (`roleHasCapability` is `undefined` because it isn't exported yet, or the capability string isn't in the Set yet) — confirm this is the actual failure reason before moving on.

- [x] **Step 6: Implement (apply Steps 1-3 above), then run `node --check server.js`**

Expected: no output (syntax OK).

- [x] **Step 7: Run test to verify it passes**

Run: `SESSION_SECRET=test-secret-please-change-me-32chars node --test test/test_firmware_ota.js`
Expected: PASS (1 test).

- [x] **Step 8: Commit**

```bash
git add server.js test/test_firmware_ota.js
git commit -m "feat: add firmware_versions/deployments tables and devices:firmware:write capability"
```

---

### Task 2: Upload-side pure helpers (token + filename generation)
**Status:** ✅ Done — commit `d784811`

**Files:**
- Modify: `server.js` — insert a new section immediately before `async function startServer() {` (currently the line right after the `/api/system/apply-update/status` route block ends)
- Modify: `server.js` `module.exports`
- Test: `test/test_firmware_ota.js` (append)

**Interfaces:**
- Consumes: `crypto` (already imported, `server.js:6`).
- Produces: `generateFirmwareDownloadToken()` → `string` (64 lowercase-hex chars). `buildFirmwareFilename(versionId, originalName)` → `string` (e.g. `fw_7.bin` — always `.bin`, ignores the original extension so a mislabeled upload can't smuggle a different extension onto disk).

- [x] **Step 1: Write the failing tests**

Append to `test/test_firmware_ota.js`:

```js
const { generateFirmwareDownloadToken, buildFirmwareFilename } = require('../server.js');

test('generateFirmwareDownloadToken returns a 64-char lowercase hex string, unique per call', () => {
    const a = generateFirmwareDownloadToken();
    const b = generateFirmwareDownloadToken();
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, b);
});

test('buildFirmwareFilename always produces a .bin filename regardless of original extension', () => {
    assert.equal(buildFirmwareFilename(7, 'firmware.bin'), 'fw_7.bin');
    assert.equal(buildFirmwareFilename(3, 'notes.txt'), 'fw_3.bin');
    assert.equal(buildFirmwareFilename(3, '../../etc/passwd'), 'fw_3.bin');
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `SESSION_SECRET=test-secret-please-change-me-32chars node --test test/test_firmware_ota.js`
Expected: FAIL — both new functions are `undefined`.

- [x] **Step 3: Implement**

Insert this new section (banner comment + functions) immediately before `async function startServer() {`:

```js
// ─── ESP32 Firmware OTA ────────────────────────────────────────────
// The firmware (firmware/nurseaid_esp32.ino) already supports pull-OTA:
// an MQTT "ota <url>" command makes it HTTP-download a .bin and self-flash,
// reporting progress back on ble/node/<id>/ota. This section is the
// server-side half: upload, host, trigger, track.

function generateFirmwareDownloadToken() {
    return crypto.randomBytes(32).toString('hex');
}

function buildFirmwareFilename(versionId, _originalName) {
    // Ignore the original name/extension entirely — the stored filename is
    // always server-generated, so a mislabeled or malicious upload can't
    // control what lands on disk (same reasoning as the notification-sound
    // uploader's user_<id>.<ext> naming).
    return `fw_${versionId}.bin`;
}
```

- [x] **Step 4: Run `node --check server.js`, then run test to verify it passes**

Run: `node --check server.js && SESSION_SECRET=test-secret-please-change-me-32chars node --test test/test_firmware_ota.js`
Expected: PASS (3 tests total).

- [x] **Step 5: Add exports and commit**

Add `generateFirmwareDownloadToken, buildFirmwareFilename` to `module.exports`.

```bash
git add server.js test/test_firmware_ota.js
git commit -m "feat: add firmware upload token/filename helpers"
```

---

### Task 3: Deploy-side pure helpers (node resolution, canary gate, URL validation, status parsing)
**Status:** ✅ Done — commit `fd61d8e`

**Files:**
- Modify: `server.js` (same new "ESP32 Firmware OTA" section from Task 2)
- Test: `test/test_firmware_ota.js` (append)

**Interfaces:**
- Consumes: nothing external — all pure functions.
- Produces:
  - `resolveNodeIdForMac(nodes, mac)` → `string | null`. `nodes` is the same array shape `esp32NodesForUi()` already returns (each item has `.boardMac`, `.nodeId` — see `server.js:7130-7148`).
  - `canDeployToTargets(deploymentRows, targetCount)` → `{ allowed: boolean, reason: string | null }`. `deploymentRows` is an array of `{ status: string, ... }` (shape of `firmware_deployments` rows).
  - `isValidOtaUrl(url)` → `boolean`.
  - `parseOtaStatusTopic(topic)` → `string | null` (extracts `<nodeId>` from `ble/node/<nodeId>/ota`, else `null`).
  - `parseOtaStatusPayload(buffer)` → `{ state, detail, version } | null` (safe JSON parse; `null` on malformed input).

- [x] **Step 1: Write the failing tests**

Append to `test/test_firmware_ota.js`:

```js
const {
    resolveNodeIdForMac,
    canDeployToTargets,
    isValidOtaUrl,
    parseOtaStatusTopic,
    parseOtaStatusPayload
} = require('../server.js');

test('resolveNodeIdForMac matches case-insensitively and returns null when not found', () => {
    const nodes = [{ boardMac: 'AA:BB:CC:DD:EE:FF', nodeId: 'na1c58c' }];
    assert.equal(resolveNodeIdForMac(nodes, 'aa:bb:cc:dd:ee:ff'), 'na1c58c');
    assert.equal(resolveNodeIdForMac(nodes, '11:22:33:44:55:66'), null);
});

test('canDeployToTargets requires a lone canary target until a success exists', () => {
    assert.deepEqual(canDeployToTargets([], 1), { allowed: true, reason: null });
    const blocked = canDeployToTargets([], 3);
    assert.equal(blocked.allowed, false);
    assert.match(blocked.reason, /canary/i);
    const rows = [{ status: 'success' }];
    assert.deepEqual(canDeployToTargets(rows, 5), { allowed: true, reason: null });
    const stillBlocked = canDeployToTargets([{ status: 'failed' }], 2);
    assert.equal(stillBlocked.allowed, false);
});

test('isValidOtaUrl only accepts http(s) URLs', () => {
    assert.equal(isValidOtaUrl('https://example.com/fw/abc/firmware.bin'), true);
    assert.equal(isValidOtaUrl('http://example.com/fw/abc/firmware.bin'), true);
    assert.equal(isValidOtaUrl('ftp://example.com/fw.bin'), false);
    assert.equal(isValidOtaUrl(''), false);
});

test('parseOtaStatusTopic extracts the nodeId, rejects other topics', () => {
    assert.equal(parseOtaStatusTopic('ble/node/na1c58c/ota'), 'na1c58c');
    assert.equal(parseOtaStatusTopic('ble/mac'), null);
    assert.equal(parseOtaStatusTopic('ble/node/na1c58c/log'), null);
});

test('parseOtaStatusPayload safely parses, returns null on malformed JSON', () => {
    assert.deepEqual(
        parseOtaStatusPayload(Buffer.from('{"state":"success","detail":"ok","version":"2.1.0"}')),
        { state: 'success', detail: 'ok', version: '2.1.0' }
    );
    assert.equal(parseOtaStatusPayload(Buffer.from('not json')), null);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `SESSION_SECRET=test-secret-please-change-me-32chars node --test test/test_firmware_ota.js`
Expected: FAIL — all five functions are `undefined`.

- [x] **Step 3: Implement**

Append to the "ESP32 Firmware OTA" section:

```js
function resolveNodeIdForMac(nodes, mac) {
    const target = String(mac || '').toUpperCase();
    const found = (nodes || []).find(n => String(n.boardMac || '').toUpperCase() === target);
    return found ? found.nodeId : null;
}

function canDeployToTargets(deploymentRows, targetCount) {
    if (targetCount <= 1) return { allowed: true, reason: null };
    const hasSuccess = (deploymentRows || []).some(row => row.status === 'success');
    if (hasSuccess) return { allowed: true, reason: null };
    return {
        allowed: false,
        reason: 'ต้อง deploy สำเร็จกับเครื่อง canary (1 เครื่อง) ก่อน ถึงจะเลือกหลายเครื่องได้'
    };
}

function isValidOtaUrl(url) {
    return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
}

function parseOtaStatusTopic(topic) {
    const match = /^ble\/node\/([^/]+)\/ota$/.exec(String(topic || ''));
    return match ? match[1] : null;
}

function parseOtaStatusPayload(buffer) {
    try {
        const data = JSON.parse(buffer.toString());
        if (!data || typeof data !== 'object') return null;
        return { state: data.state, detail: data.detail, version: data.version };
    } catch (e) {
        return null;
    }
}
```

- [x] **Step 4: Run `node --check server.js`, then run test to verify it passes**

Run: `node --check server.js && SESSION_SECRET=test-secret-please-change-me-32chars node --test test/test_firmware_ota.js`
Expected: PASS (8 tests total).

- [x] **Step 5: Add exports and commit**

Add `resolveNodeIdForMac, canDeployToTargets, isValidOtaUrl, parseOtaStatusTopic, parseOtaStatusPayload` to `module.exports`.

```bash
git add server.js test/test_firmware_ota.js
git commit -m "feat: add firmware deploy helpers (node resolution, canary gate, url/status parsing)"
```

---

### Task 4: Upload route (`POST /api/firmware/upload`)
**Status:** ✅ Done — commit `f24f72f`

**Files:**
- Modify: `server.js` (append to the "ESP32 Firmware OTA" section, after Task 3's helpers)

**Interfaces:**
- Consumes: `buildFirmwareFilename` (Task 2), `generateFirmwareDownloadToken` (Task 2), `requireCapability` (`server.js:321`), `pool` (existing pg pool), `multer`, `fs`, `path` (all already imported).
- Produces: on disk, `uploads/firmware/fw_<id>.bin`; in DB, a `firmware_versions` row.

- [x] **Step 1: Implement the route**

```js
const FIRMWARE_UPLOAD_DIR = process.env.FIRMWARE_UPLOAD_DIR || path.join(__dirname, 'uploads', 'firmware');
try { fs.mkdirSync(FIRMWARE_UPLOAD_DIR, { recursive: true }); } catch (e) { console.error('[Firmware] mkdir failed:', e.message); }

const FIRMWARE_MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // 4MB — ESP32 app partitions are typically ~1.3-1.9MB

const firmwareUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: FIRMWARE_MAX_UPLOAD_BYTES },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').replace('.', '').toLowerCase();
        if (ext === 'bin') return cb(null, true);
        cb(new Error('UNSUPPORTED_FIRMWARE_FORMAT'));
    }
}).single('firmware');

app.post('/api/firmware/upload', requireCapability('devices:firmware:write'), (req, res) => {
    firmwareUpload(req, res, async (err) => {
        if (err) {
            const error = err.message === 'UNSUPPORTED_FIRMWARE_FORMAT' ? 'UNSUPPORTED_FIRMWARE_FORMAT'
                : err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'UPLOAD_FAILED';
            return res.status(400).json({ error });
        }
        const file = req.file;
        if (!file) return res.status(400).json({ error: 'NO_FILE' });
        const version = String(req.body.version || '').trim().slice(0, 40);
        const notes = String(req.body.notes || '').trim();
        if (!version) return res.status(400).json({ error: 'VERSION_REQUIRED' });

        try {
            const token = generateFirmwareDownloadToken();
            const inserted = await pool.query(
                `INSERT INTO firmware_versions (version, notes, filename, file_size, download_token, uploaded_by)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [version, notes, '', file.size, token, req.user.id]
            );
            const versionId = inserted.rows[0].id;
            const filename = buildFirmwareFilename(versionId, file.originalname);
            fs.writeFileSync(path.join(FIRMWARE_UPLOAD_DIR, filename), file.buffer);
            await pool.query(`UPDATE firmware_versions SET filename=$1 WHERE id=$2`, [filename, versionId]);
            logAudit(req, 'CREATE', 'firmware_version', String(versionId), { version, file_size: file.size }).catch(console.error);
            res.json({ success: true, id: versionId, version });
        } catch (error) {
            console.error('[Firmware Upload]', error.message);
            res.status(500).json({ error: 'UPLOAD_FAILED' });
        }
    });
});
```

Note: the row is inserted first (to get the auto-increment `id` for the filename), then updated with the real filename — this mirrors the "need the id before the filename" ordering; there is no window where a broken row is servable, since `GET /fw/:token/...` (Task 5) 404s on any row whose file doesn't exist on disk.

- [x] **Step 2: Run `node --check server.js`**

Run: `node --check server.js`
Expected: no output.

- [x] **Step 3: Manual verification (no live DB/MQTT test harness exists in this repo — verify against a running instance)**

Start the app against a real Postgres (however this project normally runs locally, e.g. `docker compose up` per its own README), log in as a `super_admin` user, then:

```bash
curl -s -b <session-cookie> -F "firmware=@/path/to/test.bin" -F "version=0.0.1-test" -F "notes=smoke test" \
  http://localhost:<port>/api/firmware/upload
```

Expected: `{"success":true,"id":<n>,"version":"0.0.1-test"}`, and `uploads/firmware/fw_<n>.bin` exists on disk with the uploaded content.

- [x] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add ESP32 firmware upload endpoint"
```

---

### Task 5: Serve route (`GET /fw/:token/firmware.bin`)
**Status:** ✅ Done — commit `75697c0`

**Files:**
- Modify: `server.js` (append to the "ESP32 Firmware OTA" section)

**Interfaces:**
- Consumes: `pool`, `fs`, `path`, `FIRMWARE_UPLOAD_DIR` (Task 4).
- Produces: the URL the deploy endpoint (Task 7) will publish to devices.

- [x] **Step 1: Implement the route**

```js
// No capability/session gate here on purpose — the ESP32's HTTPUpdate
// client can't do cookie/session auth. Security is the token: random,
// single-purpose, not linked from anywhere but the deploy trigger itself.
app.get('/fw/:token/firmware.bin', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT filename FROM firmware_versions WHERE download_token=$1`,
            [req.params.token]
        );
        if (!result.rows.length) return res.status(404).end();
        const filePath = path.join(FIRMWARE_UPLOAD_DIR, result.rows[0].filename);
        if (!fs.existsSync(filePath)) return res.status(404).end();
        res.setHeader('Content-Type', 'application/octet-stream');
        fs.createReadStream(filePath).pipe(res);
    } catch (e) {
        console.error('[Firmware Serve]', e.message);
        res.status(500).end();
    }
});
```

- [x] **Step 2: Run `node --check server.js`**

Run: `node --check server.js`
Expected: no output.

- [x] **Step 3: Manual verification**

After Task 4's manual upload, fetch the returned token's URL directly:

```bash
curl -s http://localhost:<port>/fw/<the-download_token-from-the-DB-row>/firmware.bin -o /tmp/downloaded.bin
diff /tmp/downloaded.bin /path/to/test.bin
```

Expected: `diff` reports no difference. Also verify `curl -i http://localhost:<port>/fw/not-a-real-token/firmware.bin` returns `404` and requires **no** cookie/auth header to succeed on a valid token (confirms the ESP32 can fetch it unauthenticated).

- [x] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add unauthenticated token-based firmware .bin serving route"
```

---

### Task 6: MQTT status subscription (`ble/node/+/ota`)
**Status:** ✅ Done — commit `748edf4`

**Files:**
- Modify: `server.js:165-173` (`initMqttClient()` — this is the **first** incoming-message handler added to this file; today the client only publishes)

**Interfaces:**
- Consumes: `parseOtaStatusTopic`, `parseOtaStatusPayload` (Task 3), `pool`.
- Produces: keeps `firmware_deployments.status`/`reported_version`/`detail`/`updated_at` current as devices report OTA progress — this is what Task 8's status endpoint reads.

- [x] **Step 1: Implement the subscription + handler**

Modify `initMqttClient()`:

```js
function initMqttClient() {
    const url = `mqtt://${MQTT_HOST}:${MQTT_PORT}`;
    const options = { clientId: `nurseaid_server_${Date.now()}`, reconnectPeriod: 5000 };
    if (MQTT_USER) { options.username = MQTT_USER; options.password = MQTT_PASSWORD; }
    mqttClient = mqtt.connect(url, options);
    mqttClient.on('connect', () => {
        console.log('[MQTT] Server connected to broker');
        mqttClient.subscribe('ble/node/+/ota', { qos: 1 }, (err) => {
            if (err) console.error('[MQTT] Failed to subscribe to ble/node/+/ota:', err.message);
        });
    });
    mqttClient.on('error', (err) => console.error('[MQTT] Connection error:', err.message));
    mqttClient.on('offline', () => console.warn('[MQTT] Client went offline, will reconnect'));
    mqttClient.on('message', (topic, payload) => {
        const nodeId = parseOtaStatusTopic(topic);
        if (!nodeId) return; // not an OTA status message — nothing else is subscribed today, but stay defensive
        const parsed = parseOtaStatusPayload(payload);
        if (!parsed) {
            console.error(`[Firmware OTA] Malformed status payload from node ${nodeId}`);
            return;
        }
        handleOtaStatusMessage(nodeId, parsed).catch(err =>
            console.error('[Firmware OTA] Failed to record status:', err.message));
    });
}

async function handleOtaStatusMessage(nodeId, { state, detail, version }) {
    // The status message carries nodeId (from the topic), not board_mac —
    // map it via the same topology data /api/esp32-nodes already builds.
    // esp32NodesForUi() calls wardScopeSql(req,...), which short-circuits
    // to "no ward filter" for role==='super_admin' before touching any
    // other field (server.js:337-338) — so this synthetic super_admin
    // "request" is sufficient for a background MQTT handler that has no
    // real req, and deliberately sees every ward (this handler must be
    // able to match ANY node, not just ones in some ward's scope).
    const topology = await esp32NodesForUi({ user: { role: 'super_admin' } });
    const node = (topology.nodes || []).find(n => n.nodeId === nodeId);
    if (!node) {
        console.error(`[Firmware OTA] Status from unknown nodeId ${nodeId} — no matching board_mac`);
        return;
    }
    // Update the most recent pending/start deployment row for this board.
    await pool.query(
        `UPDATE firmware_deployments
         SET status=$1, detail=$2, reported_version=$3, updated_at=NOW()
         WHERE id = (
             SELECT id FROM firmware_deployments
             WHERE board_mac=$4 AND status IN ('pending','start')
             ORDER BY requested_at DESC LIMIT 1
         )`,
        [state, detail || null, version || null, node.boardMac]
    );
}
```

- [x] **Step 2: Run `node --check server.js`**

Run: `node --check server.js`
Expected: no output.

- [x] **Step 3: Manual verification**

With the app running and connected to a real MQTT broker, manually publish a status message and confirm it lands in the DB (requires a pending `firmware_deployments` row to exist first — created in Task 7's verification, so this step can be re-run after Task 7 too):

```bash
mosquitto_pub -h <broker-host> -t 'ble/node/na1c58c/ota' -m '{"state":"success","detail":"rebooting","version":"2.1.0"}'
```

Then: `SELECT status, detail, reported_version FROM firmware_deployments ORDER BY id DESC LIMIT 1;` should show `status='success'`, `reported_version='2.1.0'`.

- [x] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: subscribe to ble/node/+/ota and record firmware deployment status"
```

---

### Task 7: Deploy route (`POST /api/firmware/deploy`)
**Status:** ✅ Done — commit `839a90d`

**Files:**
- Modify: `server.js` (append to the "ESP32 Firmware OTA" section)

**Interfaces:**
- Consumes: `resolveNodeIdForMac`, `canDeployToTargets`, `isValidOtaUrl` (Task 3), `esp32NodesForUi` (existing, `server.js:7093`), `mqttClient` (existing), `pool`.
- Produces: `firmware_deployments` rows with `status='pending'`; an MQTT publish per target.

- [x] **Step 1: Implement the route**

```js
app.post('/api/firmware/deploy', requireCapability('devices:firmware:write'), async (req, res) => {
    const versionId = Number.parseInt(req.body.versionId, 10);
    const targets = Array.isArray(req.body.targets) ? req.body.targets.map(String) : [];
    if (!Number.isInteger(versionId) || targets.length === 0) {
        return res.status(400).json({ error: 'INVALID_REQUEST' });
    }

    try {
        const versionResult = await pool.query(`SELECT id, download_token FROM firmware_versions WHERE id=$1`, [versionId]);
        if (!versionResult.rows.length) return res.status(404).json({ error: 'VERSION_NOT_FOUND' });
        const { download_token } = versionResult.rows[0];

        const existingDeployments = await pool.query(
            `SELECT status FROM firmware_deployments WHERE version_id=$1`, [versionId]
        );
        const gate = canDeployToTargets(existingDeployments.rows, targets.length);
        if (!gate.allowed) return res.status(400).json({ error: 'CANARY_REQUIRED', message: gate.reason });

        const origin = APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
        const url = `${origin}/fw/${download_token}/firmware.bin`;
        if (!isValidOtaUrl(url)) return res.status(500).json({ error: 'INVALID_URL' });

        const topology = await esp32NodesForUi(req);
        const results = [];
        for (const boardMac of targets) {
            const nodeId = resolveNodeIdForMac(topology.nodes, boardMac);
            if (!nodeId) {
                results.push({ boardMac, ok: false, error: 'NODE_NOT_FOUND' });
                continue;
            }
            await pool.query(
                `INSERT INTO firmware_deployments (version_id, board_mac, status, requested_by)
                 VALUES ($1, $2, 'pending', $3)`,
                [versionId, boardMac, req.user.id]
            );
            const cmdTopic = `ble/node/${nodeId}/cmd`; // per-node only — never ble/node/all/cmd
            mqttClient.publish(cmdTopic, `ota ${url}`, { qos: 1 });
            results.push({ boardMac, ok: true, nodeId });
        }
        logAudit(req, 'system:firmware_deploy:start', 'firmware_version', String(versionId), { targets }).catch(console.error);
        res.json({ success: true, results });
    } catch (error) {
        console.error('[Firmware Deploy]', error.message);
        res.status(500).json({ error: 'DEPLOY_FAILED' });
    }
});
```

- [x] **Step 2: Run `node --check server.js`**

Run: `node --check server.js`
Expected: no output.

- [x] **Step 3: Manual verification**

```bash
# First attempt with 2 targets on a brand-new version — must be rejected (canary gate)
curl -s -X POST -b <session-cookie> -H 'Content-Type: application/json' \
  -d '{"versionId": <id>, "targets": ["AA:BB:CC:DD:EE:FF", "11:22:33:44:55:66"]}' \
  http://localhost:<port>/api/firmware/deploy
# Expected: {"error":"CANARY_REQUIRED", "message": "..."}

# Canary with 1 target — must succeed
curl -s -X POST -b <session-cookie> -H 'Content-Type: application/json' \
  -d '{"versionId": <id>, "targets": ["AA:BB:CC:DD:EE:FF"]}' \
  http://localhost:<port>/api/firmware/deploy
# Expected: {"success":true, "results":[{"boardMac":"AA:BB:CC:DD:EE:FF","ok":true,"nodeId":"..."}]}
```

Then manually mark that deployment `success` (Task 6's manual verification, or `UPDATE firmware_deployments SET status='success' WHERE id=<id>;` directly), and re-run the 2-target request — it should now succeed.

- [x] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add canary-gated firmware deploy endpoint"
```

---

### Task 8: Status list route (`GET /api/firmware/deployments`)
**Status:** ✅ Done — commit `62ff70d`

**Files:**
- Modify: `server.js` (append to the "ESP32 Firmware OTA" section)

**Interfaces:**
- Consumes: `pool`.
- Produces: the JSON the UI (Task 9) polls.

- [x] **Step 1: Implement the route**

```js
app.get('/api/firmware/deployments', requireCapability('devices:firmware:write'), async (req, res) => {
    const versionId = Number.parseInt(req.query.versionId, 10);
    if (!Number.isInteger(versionId)) return res.status(400).json({ error: 'INVALID_REQUEST' });
    try {
        const result = await pool.query(
            `SELECT board_mac, status, reported_version, detail, requested_at, updated_at
             FROM firmware_deployments WHERE version_id=$1 ORDER BY requested_at DESC`,
            [versionId]
        );
        res.json({ deployments: result.rows });
    } catch (error) {
        console.error('[Firmware Deployments]', error.message);
        res.status(500).json({ error: 'QUERY_FAILED' });
    }
});

app.get('/api/firmware/versions', requireCapability('devices:firmware:write'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT fv.id, fv.version, fv.notes, fv.uploaded_at,
                    EXISTS(SELECT 1 FROM firmware_deployments fd WHERE fd.version_id=fv.id AND fd.status='success') AS canary_passed
             FROM firmware_versions fv ORDER BY fv.uploaded_at DESC`
        );
        res.json({ versions: result.rows });
    } catch (error) {
        console.error('[Firmware Versions]', error.message);
        res.status(500).json({ error: 'QUERY_FAILED' });
    }
});
```

(`/api/firmware/versions` was implied by the spec's "version list" UI section but not spelled out as its own endpoint — adding it here since Task 9's UI needs a list to render, and it belongs with this task's other read-only query route.)

- [x] **Step 2: Run `node --check server.js`**

Run: `node --check server.js`
Expected: no output.

- [x] **Step 3: Manual verification**

```bash
curl -s -b <session-cookie> 'http://localhost:<port>/api/firmware/versions'
curl -s -b <session-cookie> "http://localhost:<port>/api/firmware/deployments?versionId=<id>"
```

Expected: JSON arrays reflecting the rows created in earlier tasks' manual verification steps.

- [x] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add firmware versions/deployments read endpoints"
```

---

### Task 9: UI card on `/system-mgmt`
**Status:** ✅ Done — commit `3d49e7d`

**Files:**
- Modify: `server.js:11086-11227` (the `/system-mgmt` route — add a new card to its `content`, and new functions to its `script` argument)

**Interfaces:**
- Consumes: `/api/firmware/versions`, `/api/firmware/upload`, `/api/firmware/deploy`, `/api/firmware/deployments` (Tasks 4/7/8), `/api/esp32-nodes` (existing, `server.js:7165`), `confirmAction()` (existing, `server.js:4291`), `escapeHTML()`/`statusIcon()` (existing, used by the neighboring Check-for-Updates UI).

- [x] **Step 1: Add the HTML card**

Insert this new `<div>` inside the `/system-mgmt` route's `content` template literal, directly after the closing `</div>` of the existing "เวอร์ชันปัจจุบัน" card (i.e. right before the closing backtick of the 3rd argument to `ui(...)`):

```html
<div class="rounded-2xl border p-5 md:p-6 mt-6" style="background: var(--bg-card); border-color: var(--border-color);">
    <h3 class="text-lg font-black mb-1" style="color: var(--text-heading);">อัปเดตเฟิร์มแวร์ ESP32</h3>
    <p class="text-sm mb-4" style="color: var(--text-secondary);">อัปโหลดไฟล์ .bin แล้วทดสอบกับเครื่อง canary 1 เครื่องก่อน จึงจะเลือกส่งไปหลายเครื่องได้</p>

    <form id="firmware-upload-form" class="flex flex-col sm:flex-row gap-3 mb-5" onsubmit="return false;">
        <input type="file" id="firmware-file-input" accept=".bin" required class="text-sm">
        <input type="text" id="firmware-version-input" placeholder="เวอร์ชัน เช่น 1.3.0" required maxlength="40"
               class="rounded-xl border px-3 py-2 text-sm" style="background: var(--bg-input); border-color: var(--border-color);">
        <input type="text" id="firmware-notes-input" placeholder="เปลี่ยนแปลงอะไรบ้าง (ไม่บังคับ)"
               class="flex-1 rounded-xl border px-3 py-2 text-sm" style="background: var(--bg-input); border-color: var(--border-color);">
        <button type="button" onclick="uploadFirmware()" id="firmware-upload-btn"
                class="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-bold shadow-lg"
                style="background: var(--accent-primary-strong); color: var(--text-inverse);">อัปโหลด</button>
    </form>
    <p id="firmware-upload-status" class="text-sm mb-4" style="color: var(--text-secondary);"></p>

    <div id="firmware-version-list"></div>
</div>
```

- [x] **Step 2: Add the client-side JS**

Append this to the `/system-mgmt` route's `script` argument (the 4th argument to `ui(...)`, after `applyUpdate()`'s closing brace):

```js
let firmwareDeployPollTimer = null;

async function loadFirmwareVersions() {
    const r = await fetch('/api/firmware/versions');
    const data = await r.json().catch(() => ({}));
    const list = document.getElementById('firmware-version-list');
    list.replaceChildren();
    (data.versions || []).forEach(v => {
        const row = document.createElement('div');
        row.className = 'rounded-xl border p-3 mb-2 flex items-center justify-between gap-3';
        row.style.background = 'var(--bg-input)';
        const label = document.createElement('div');
        label.innerHTML = '<span class="font-bold">v' + escapeHTML(v.version) + '</span>' +
            (v.canary_passed ? ' <span class="text-xs text-green-700">canary ผ่านแล้ว</span>' : ' <span class="text-xs text-amber-700">ยังไม่ผ่าน canary</span>') +
            (v.notes ? '<div class="text-xs" style="color:var(--text-secondary);">' + escapeHTML(v.notes) + '</div>' : '');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold';
        btn.style.background = 'var(--accent-primary-strong)';
        btn.style.color = 'var(--text-inverse)';
        btn.textContent = 'ส่งไปเครื่อง...';
        btn.onclick = () => openFirmwareDeployPicker(v.id, Boolean(v.canary_passed));
        row.appendChild(label);
        row.appendChild(btn);
        list.appendChild(row);
    });
}

async function uploadFirmware() {
    const fileInput = document.getElementById('firmware-file-input');
    const versionInput = document.getElementById('firmware-version-input');
    const notesInput = document.getElementById('firmware-notes-input');
    const statusEl = document.getElementById('firmware-upload-status');
    if (!fileInput.files[0] || !versionInput.value.trim()) {
        statusEl.textContent = 'กรุณาเลือกไฟล์ .bin และกรอกเวอร์ชัน';
        return;
    }
    const fd = new FormData();
    fd.append('firmware', fileInput.files[0]);
    fd.append('version', versionInput.value.trim());
    fd.append('notes', notesInput.value.trim());
    statusEl.textContent = 'กำลังอัปโหลด...';
    try {
        const r = await fetch('/api/firmware/upload', { method: 'POST', body: fd });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'UPLOAD_FAILED');
        statusEl.textContent = 'อัปโหลดสำเร็จ: v' + escapeHTML(data.version);
        fileInput.value = ''; versionInput.value = ''; notesInput.value = '';
        loadFirmwareVersions();
    } catch (e) {
        statusEl.textContent = 'อัปโหลดล้มเหลว: ' + escapeHTML(e.message);
    }
}

async function openFirmwareDeployPicker(versionId, canaryPassed) {
    const r = await fetch('/api/esp32-nodes');
    const data = await r.json().catch(() => ({}));
    const nodes = data.nodes || [];
    if (!nodes.length) { alert('ไม่พบเครื่อง ESP32'); return; }
    const options = nodes.map(n => n.boardMac + (n.description ? ' - ' + n.description : '')).join('\n');
    const chosen = prompt(
        (canaryPassed ? 'พิมพ์ MAC เครื่องที่จะส่ง (คั่นด้วย , ได้หลายเครื่อง)' : 'พิมพ์ MAC เครื่อง canary 1 เครื่อง') +
        '\n\nเครื่องที่มี:\n' + options
    );
    if (!chosen) return;
    const targets = chosen.split(',').map(s => s.trim()).filter(Boolean);
    const confirmed = await confirmAction({
        title: 'ยืนยันการ deploy เฟิร์มแวร์',
        kind: 'danger',
        body: '<p>จะส่งเฟิร์มแวร์ไปยัง ' + targets.length + ' เครื่อง</p>',
        confirmText: 'Deploy'
    });
    if (!confirmed) return;
    const r2 = await fetch('/api/firmware/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId, targets })
    });
    const result = await r2.json();
    if (!r2.ok) { alert('Deploy ล้มเหลว: ' + (result.message || result.error)); return; }
    pollFirmwareDeployments(versionId);
}

async function pollFirmwareDeployments(versionId) {
    if (firmwareDeployPollTimer) clearInterval(firmwareDeployPollTimer);
    const poll = async () => {
        const r = await fetch('/api/firmware/deployments?versionId=' + versionId);
        const data = await r.json().catch(() => ({}));
        const rows = data.deployments || [];
        const allTerminal = rows.length > 0 && rows.every(d => ['success', 'no_update', 'failed', 'timeout'].includes(d.status));
        console.log('[Firmware] deployment status', rows);
        if (allTerminal) { clearInterval(firmwareDeployPollTimer); loadFirmwareVersions(); }
    };
    poll();
    firmwareDeployPollTimer = window.setInterval(poll, 3000);
}

loadFirmwareVersions();
```

Note for whoever implements this task: the device picker above uses a plain `prompt()`/`alert()` rather than a full custom modal — that's a deliberate v1 simplification to keep this task's scope to "wire the endpoints into a usable UI", consistent with YAGNI; swapping it for a richer checkbox-list modal is a natural, isolated follow-up that doesn't change any endpoint contract.

- [x] **Step 3: Run `node --check server.js`**

Run: `node --check server.js`
Expected: no output.

- [x] **Step 4: Manual verification (browser)**

Log in as `super_admin`, open `/system-mgmt`, confirm the new "อัปเดตเฟิร์มแวร์ ESP32" card renders below "เวอร์ชันปัจจุบัน". Upload a small test `.bin`, confirm it appears in the version list marked "ยังไม่ผ่าน canary". Click "ส่งไปเครื่อง...", enter one MAC, confirm the `confirmAction` modal appears, confirm, and watch the browser's Network tab show `/api/firmware/deployments` being polled every 3s.

- [x] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: add ESP32 firmware OTA card to /system-mgmt page"
```

---

### Task 10: End-to-end smoke test with a real device (or simulated MQTT)
**Status:** 🟡 Mostly verified (2026-09-10).
- Step 1 **done**: `npm run test:offline` → 83/83 pass, 0 fail (incl. the 8 `test/test_firmware_ota.js` tests).
  `npm test` integration step prints the three documented `SKIP integration:` lines and exits 0 — files are
  gitignored/absent, so that is an honest skip, not a pass. `node --check` clean on server.js, live-status.js,
  esp32-status.js, or-patients.js.
- Step 2 **partly evidenced by real hardware**, not by a fresh scripted walkthrough. `firmware_deployments`
  already holds real round-trips against live node `48:27:E2:B7:7F:18` (`nb77f18`): ids 5, 6 (version 3) and
  id 7 (version 5) reached `success`; ids 2, 3 reached `failed`; ids 10, 11 (version 3, two boards) are
  `cancelled`. So upload → per-node publish → status callback → DB persistence is proven end to end.
  Still **not** directly observed: the UI polling flip to "canary ผ่านแล้ว" (item 4) and the `CANARY_REQUIRED`
  rejection on a never-deployed version (item 5). The canary-gate helper itself is unit-tested in Task 3.
- Step 3: no fixups were needed, so no walkthrough commit.

⚠️ Re-running item 5 against this machine means publishing a real `ota` command to `nb77f18`, which currently
has a patient watch (`EC:35:0D:31:14:F6`) connected. Do that only during a maintenance window, or point the
deploy at the disconnected board `48:27:E2:B7:89:C4` instead.

**Files:** none (verification-only task)

- [x] **Step 1: Run the full automated test suite**

Run: `npm test`
Expected: all existing tests plus every `test/test_firmware_ota.js` test pass (8 tests from Tasks 1-3).

- [ ] **Step 2: Full manual walkthrough**

With the app connected to a real Postgres + MQTT broker (and ideally one real ESP32 running `firmware/nurseaid_esp32.ino`, or `mosquitto_sub -t 'ble/node/+/cmd'` standing in for one):
1. Upload a `.bin` (a real compiled one if available, otherwise any small file — the flow doesn't need it to actually flash to prove the wiring).
2. Deploy to 1 device (or the `mosquitto_sub` stand-in) — confirm the exact MQTT message published is `ota https://<host>/fw/<token>/firmware.bin` on `ble/node/<nodeId>/cmd` (not `ble/node/all/cmd`).
3. If using a real device: confirm it downloads and reports status on `ble/node/<nodeId>/ota`; if using the stand-in: `mosquitto_pub` a fake success message as in Task 6 Step 3.
4. Confirm the `/system-mgmt` UI's polling picks up the `success` status and the version flips to "canary ผ่านแล้ว".
5. Attempt a 2-device deploy on a *different*, never-deployed version — confirm it's rejected with `CANARY_REQUIRED`.

- [ ] **Step 3: Final commit (if any fixups were needed during the walkthrough)**

```bash
git add -A
git commit -m "fix: address issues found during firmware OTA end-to-end walkthrough"
```

(Skip this commit if no fixes were needed.)
