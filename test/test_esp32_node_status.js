'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseHeartbeatTopic,
    parseHeartbeatPayload,
    parseEsp32InventoryPayload,
    parseBootTopic,
    parseBootPayload
} = require('../server.js');

test('parseHeartbeatTopic extracts the bare nodeId from ble/node/<id>', () => {
    assert.equal(parseHeartbeatTopic('ble/node/na1c58c'), 'na1c58c');
    assert.equal(parseHeartbeatTopic('ble/node/abc123'), 'abc123');
});

test('parseHeartbeatTopic rejects any topic with a further suffix or non-matching shape', () => {
    // The heartbeat publishes to the BARE topic ble/node/<id> — no suffix.
    assert.equal(parseHeartbeatTopic('ble/node/na1c58c/ota'), null);
    assert.equal(parseHeartbeatTopic('ble/node/na1c58c/boot'), null);
    assert.equal(parseHeartbeatTopic('ble/node/na1c58c/log'), null);
    assert.equal(parseHeartbeatTopic('ble/node/na1c58c/devices'), null);
    assert.equal(parseHeartbeatTopic('ble/node/+/heartbeat'), null);
    assert.equal(parseHeartbeatTopic('ble/esp32'), null);
    assert.equal(parseHeartbeatTopic('ble/mac'), null);
    assert.equal(parseHeartbeatTopic('nurseaid/paired_devices'), null);
    assert.equal(parseHeartbeatTopic(''), null);
    assert.equal(parseHeartbeatTopic(null), null);
    assert.equal(parseHeartbeatTopic(undefined), null);
});

test('parseHeartbeatPayload parses valid heartbeat JSON and passes through fields', () => {
    const payload = Buffer.from(
        '{"uptime":5400,"links":3,"heap":190000,"wifi_rssi":-62,"time_ok":1,"boot_reason":"BOD","version":"2.3.1","ip":"172.16.5.9"}'
    );
    const parsed = parseHeartbeatPayload(payload);
    assert.deepEqual(parsed, {
        uptime: 5400,
        heap: 190000,
        wifi_rssi: -62,
        time_ok: 1,
        boot_reason: 'BOD',
        version: '2.3.1',
        ip: '172.16.5.9',
        mqtt_broker: null,
        mqtt_port: null,
        max_devices: null
    });
});

test('parseHeartbeatPayload passes through broker, port and max_devices when present', () => {
    const payload = Buffer.from(
        '{"uptime":5400,"heap":190000,"wifi_rssi":-62,"time_ok":1,"boot_reason":"BOD","version":"2.3.1","ip":"172.16.5.9","mqtt_broker":"172.16.251.50","mqtt_port":1883,"max_devices":8}'
    );
    const parsed = parseHeartbeatPayload(payload);
    assert.equal(parsed.mqtt_broker, '172.16.251.50');
    assert.equal(parsed.mqtt_port, 1883);
    assert.equal(parsed.max_devices, 8);
});

test('parseHeartbeatPayload tolerates a missing boot_reason (older in-field firmware)', () => {
    const payload = Buffer.from('{"uptime":12,"heap":200000,"wifi_rssi":-70,"time_ok":0}');
    const parsed = parseHeartbeatPayload(payload);
    assert.equal(parsed.boot_reason, null);
    assert.equal(parsed.uptime, 12);
    assert.equal(parsed.heap, 200000);
    assert.equal(parsed.wifi_rssi, -70);
    assert.equal(parsed.time_ok, 0);
});

test('parseHeartbeatPayload returns null on malformed JSON or non-object payloads', () => {
    assert.equal(parseHeartbeatPayload(Buffer.from('not json')), null);
    assert.equal(parseHeartbeatPayload(Buffer.from('[1,2,3]')), null);
    assert.equal(parseHeartbeatPayload(Buffer.from('"a string"')), null);
    assert.equal(parseHeartbeatPayload(Buffer.from('42')), null);
});

test('parseEsp32InventoryPayload accepts a valid payload and returns exactly nodeId/boardMac/ipAddress', () => {
    // devices/count are part of the wire format but are ignored on purpose —
    // the registry only cares about identity (nodeId + boardMac + ip).
    const payload = Buffer.from(
        '{"node_id":"na1c58c","mac":"F0:F5:BD:A1:C5:8C","ip":"172.16.251.32","devices":["EC:35:0D:31:14:F6"],"count":1}'
    );
    assert.deepEqual(parseEsp32InventoryPayload(payload), {
        nodeId: 'na1c58c',
        boardMac: 'F0:F5:BD:A1:C5:8C',
        ipAddress: '172.16.251.32'
    });
});

test('parseEsp32InventoryPayload canonicalises lowercase and dash-separated MACs', () => {
    const lower = Buffer.from('{"node_id":"na1c58c","mac":"f0:f5:bd:a1:c5:8c","ip":"172.16.251.32"}');
    assert.equal(parseEsp32InventoryPayload(lower).boardMac, 'F0:F5:BD:A1:C5:8C');
    const dashed = Buffer.from('{"node_id":"na1c58c","mac":"f0-f5-bd-a1-c5-8c","ip":"172.16.251.32"}');
    assert.equal(parseEsp32InventoryPayload(dashed).boardMac, 'F0:F5:BD:A1:C5:8C');
});

test('parseEsp32InventoryPayload returns null on malformed JSON or non-object payloads', () => {
    assert.equal(parseEsp32InventoryPayload(Buffer.from('not json')), null);
    assert.equal(parseEsp32InventoryPayload(Buffer.from('[1,2,3]')), null);
    assert.equal(parseEsp32InventoryPayload(Buffer.from('"a string"')), null);
    assert.equal(parseEsp32InventoryPayload(Buffer.from('42')), null);
});

test('parseEsp32InventoryPayload rejects missing, empty, invalid or oversized node_id', () => {
    const valid = (nodeId) => Buffer.from(
        JSON.stringify({ node_id: nodeId, mac: 'F0:F5:BD:A1:C5:8C', ip: '172.16.251.32' })
    );
    assert.equal(parseEsp32InventoryPayload(Buffer.from('{"mac":"F0:F5:BD:A1:C5:8C","ip":"172.16.251.32"}')), null);
    assert.equal(parseEsp32InventoryPayload(valid('')), null);
    assert.equal(parseEsp32InventoryPayload(valid('na/1c5')), null);
    assert.equal(parseEsp32InventoryPayload(valid('na 1c5')), null);
    assert.equal(parseEsp32InventoryPayload(valid('a'.repeat(65))), null);
    // Boundary: exactly 64 characters is still accepted.
    assert.equal(parseEsp32InventoryPayload(valid('a'.repeat(64))).nodeId, 'a'.repeat(64));
});

test('parseEsp32InventoryPayload rejects a missing or invalid board MAC', () => {
    assert.equal(parseEsp32InventoryPayload(Buffer.from('{"node_id":"na1c58c","ip":"172.16.251.32"}')), null);
    assert.equal(parseEsp32InventoryPayload(Buffer.from('{"node_id":"na1c58c","mac":"not-a-mac","ip":"172.16.251.32"}')), null);
    // 5 octets is not a MAC.
    assert.equal(parseEsp32InventoryPayload(Buffer.from('{"node_id":"na1c58c","mac":"F0:F5:BD:A1:C5","ip":"172.16.251.32"}')), null);
});

test('parseEsp32InventoryPayload rejects a missing or empty ip', () => {
    assert.equal(parseEsp32InventoryPayload(Buffer.from('{"node_id":"na1c58c","mac":"F0:F5:BD:A1:C5:8C"}')), null);
    assert.equal(parseEsp32InventoryPayload(Buffer.from('{"node_id":"na1c58c","mac":"F0:F5:BD:A1:C5:8C","ip":""}')), null);
    assert.equal(parseEsp32InventoryPayload(Buffer.from('{"node_id":"na1c58c","mac":"F0:F5:BD:A1:C5:8C","ip":"   "}')), null);
});

test('parseBootTopic extracts the nodeId from ble/node/<id>/boot', () => {
    assert.equal(parseBootTopic('ble/node/na1c58c/boot'), 'na1c58c');
    assert.equal(parseBootTopic('ble/node/abc123/boot'), 'abc123');
});

test('parseBootTopic rejects the bare heartbeat topic, other suffixes and non-boot topics', () => {
    // The boot message publishes to ble/node/<id>/boot exactly — the bare
    // heartbeat topic (no suffix) and other per-node topics must not match,
    // otherwise a heartbeat would be misrouted into the boot handler.
    assert.equal(parseBootTopic('ble/node/na1c58c'), null);
    assert.equal(parseBootTopic('ble/node/na1c58c/ota'), null);
    assert.equal(parseBootTopic('ble/node/na1c58c/devices'), null);
    assert.equal(parseBootTopic('ble/node/na1c58c/log'), null);
    assert.equal(parseBootTopic('ble/esp32'), null);
    assert.equal(parseBootTopic(''), null);
    assert.equal(parseBootTopic(null), null);
    assert.equal(parseBootTopic(undefined), null);
});

test('parseBootPayload accepts a realistic production payload (Thai text + emoji) and ignores md5', () => {
    // Real firmware payloads carry free-form Thai/emoji boot reasons and an
    // md5 field the server does not use. The parser must survive UTF-8 and
    // return exactly { bootCount, reason, version } — nothing else.
    const payload = Buffer.from('{"boot":9,"reason":"🔴 Task watchdog (loop ค้าง)","version":"2.1.0","md5":"a3c10346"}');
    assert.deepEqual(parseBootPayload(payload), {
        bootCount: 9,
        reason: '🔴 Task watchdog (loop ค้าง)',
        version: '2.1.0'
    });
});

test('parseBootPayload accepts boot: 0 (a valid first boot)', () => {
    // 0 is a legitimate counter value (first boot after a fresh flash). A
    // falsy check like `if (!bootCount)` would wrongly reject it.
    assert.deepEqual(parseBootPayload(Buffer.from('{"boot":0}')), {
        bootCount: 0,
        reason: null,
        version: null
    });
});

test('parseBootPayload rejects a missing, boolean, negative, non-integer or string boot', () => {
    // bootCount is the anchor of the retained-replay guard, so it must be a
    // trustworthy non-negative integer. Each of these would corrupt the
    // decision table (e.g. "9" > 8 is true for strings and would log a
    // phantom reboot).
    assert.equal(parseBootPayload(Buffer.from('{"reason":"x"}')), null);
    assert.equal(parseBootPayload(Buffer.from('{"boot":true}')), null);
    assert.equal(parseBootPayload(Buffer.from('{"boot":-1}')), null);
    assert.equal(parseBootPayload(Buffer.from('{"boot":2.5}')), null);
    assert.equal(parseBootPayload(Buffer.from('{"boot":"9"}')), null);
});

test('parseBootPayload returns null for malformed JSON, arrays, bare strings and numbers', () => {
    assert.equal(parseBootPayload(Buffer.from('not json')), null);
    assert.equal(parseBootPayload(Buffer.from('[1,2,3]')), null);
    assert.equal(parseBootPayload(Buffer.from('"a string"')), null);
    assert.equal(parseBootPayload(Buffer.from('42')), null);
});

test('parseBootPayload caps an over-long reason at 200 chars and version at 40 chars', () => {
    // reason is stored in a JSONB detail column and version feeds the
    // VARCHAR(40) last_fw_version column — unbounded device text must not
    // bloat either.
    const longReason = parseBootPayload(Buffer.from(JSON.stringify({ boot: 1, reason: 'ก'.repeat(300) })));
    assert.equal(longReason.reason.length, 200);
    assert.equal(longReason.reason, 'ก'.repeat(200));
    const longVersion = parseBootPayload(Buffer.from(JSON.stringify({ boot: 1, version: 'v'.repeat(50) })));
    assert.equal(longVersion.version.length, 40);
    // Boundary: exactly at the cap is still accepted in full.
    assert.equal(parseBootPayload(Buffer.from(JSON.stringify({ boot: 1, reason: 'ก'.repeat(200) }))).reason.length, 200);
    assert.equal(parseBootPayload(Buffer.from(JSON.stringify({ boot: 1, version: 'v'.repeat(40) }))).version.length, 40);
});

test('parseBootPayload tolerates missing reason and version (older firmware)', () => {
    // Older in-field firmware may omit reason/version; absence must not fail
    // parsing — both surface as null.
    assert.deepEqual(parseBootPayload(Buffer.from('{"boot":3}')), {
        bootCount: 3,
        reason: null,
        version: null
    });
});
