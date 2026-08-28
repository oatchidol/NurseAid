'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseHeartbeatTopic,
    parseHeartbeatPayload
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
        ip: '172.16.5.9'
    });
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
