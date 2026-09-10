'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { roleHasCapability } = require('../server.js');
const { generateFirmwareDownloadToken, buildFirmwareFilename } = require('../server.js');
const { isUsableBrokerAddr, nodeSupportsBrokerArg } = require('../server.js');
const {
    resolveNodeIdForMac,
    canDeployToTargets,
    isValidOtaUrl,
    parseOtaStatusTopic,
    parseOtaStatusPayload
} = require('../server.js');

test('devices:firmware:write is granted only to super_admin', () => {
    assert.equal(roleHasCapability('super_admin', 'devices:firmware:write'), true);
    assert.equal(roleHasCapability('ward_admin', 'devices:firmware:write'), false);
    assert.equal(roleHasCapability('staff_nurse', 'devices:firmware:write'), false);
    assert.equal(roleHasCapability('viewer', 'devices:firmware:write'), false);
});

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

test('isUsableBrokerAddr accepts usable IPv4 addresses and trims surrounding whitespace', () => {
    assert.equal(isUsableBrokerAddr('172.16.251.50'), true);
    assert.equal(isUsableBrokerAddr('10.0.0.1'), true);
    assert.equal(isUsableBrokerAddr('192.168.1.1'), true);
    assert.equal(isUsableBrokerAddr('8.8.8.8'), true);
    assert.equal(isUsableBrokerAddr(' 172.16.251.50 '), true);
});

test('isUsableBrokerAddr rejects values that are not dotted-quad IPv4 addresses', () => {
    assert.equal(isUsableBrokerAddr(''), false);
    assert.equal(isUsableBrokerAddr('abc'), false);
    assert.equal(isUsableBrokerAddr('172.16.251'), false);
    assert.equal(isUsableBrokerAddr('172.16.251.50.1'), false);
    assert.equal(isUsableBrokerAddr('172.16.251.x'), false);
    assert.equal(isUsableBrokerAddr('nurseaid.local'), false);
    assert.equal(isUsableBrokerAddr('2001:db8::1'), false);
    assert.equal(isUsableBrokerAddr('172.16.251.50:1883'), false);
});

test('isUsableBrokerAddr rejects out-of-range octets', () => {
    assert.equal(isUsableBrokerAddr('256.1.1.1'), false);
    assert.equal(isUsableBrokerAddr('1.1.1.256'), false);
    assert.equal(isUsableBrokerAddr('999.1.1.1'), false);
});

test('isUsableBrokerAddr rejects ambiguous leading zeros', () => {
    assert.equal(isUsableBrokerAddr('172.016.251.50'), false);
    assert.equal(isUsableBrokerAddr('01.1.1.1'), false);
});

test('isUsableBrokerAddr rejects reserved or unusable addresses', () => {
    assert.equal(isUsableBrokerAddr('0.0.0.0'), false);
    assert.equal(isUsableBrokerAddr('0.1.2.3'), false);
    assert.equal(isUsableBrokerAddr('127.0.0.1'), false);
    assert.equal(isUsableBrokerAddr('127.1.1.1'), false);
    assert.equal(isUsableBrokerAddr('255.255.255.255'), false);
    assert.equal(isUsableBrokerAddr('192.168.1.255'), false);
});

test('isUsableBrokerAddr rejects non-string values', () => {
    assert.equal(isUsableBrokerAddr(null), false);
    assert.equal(isUsableBrokerAddr(undefined), false);
    assert.equal(isUsableBrokerAddr(12345), false);
    assert.equal(isUsableBrokerAddr({}), false);
    assert.equal(isUsableBrokerAddr([]), false);
});

test('nodeSupportsBrokerArg supports firmware versions at or above 2.1.0', () => {
    assert.equal(nodeSupportsBrokerArg('2.1.0'), true);
    assert.equal(nodeSupportsBrokerArg('2.1.1'), true);
    assert.equal(nodeSupportsBrokerArg('2.2.0'), true);
    assert.equal(nodeSupportsBrokerArg('3.0.0'), true);
    assert.equal(nodeSupportsBrokerArg('10.0.0'), true);
});

test('nodeSupportsBrokerArg rejects firmware versions below 2.1.0', () => {
    assert.equal(nodeSupportsBrokerArg('2.0.9'), false);
    assert.equal(nodeSupportsBrokerArg('2.0.0'), false);
    assert.equal(nodeSupportsBrokerArg('1.9.9'), false);
});

test('nodeSupportsBrokerArg treats unknown firmware as unsupported so a broker arg is never sent blind', () => {
    assert.equal(nodeSupportsBrokerArg(null), false);
    assert.equal(nodeSupportsBrokerArg(undefined), false);
    assert.equal(nodeSupportsBrokerArg(''), false);
    assert.equal(nodeSupportsBrokerArg('unknown'), false);
    assert.equal(nodeSupportsBrokerArg('2.1'), false);
    assert.equal(nodeSupportsBrokerArg('v2.1.0'), false);
    assert.equal(nodeSupportsBrokerArg(123), false);
    assert.equal(nodeSupportsBrokerArg({}), false);
});
