'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { roleHasCapability } = require('../server.js');
const { generateFirmwareDownloadToken, buildFirmwareFilename } = require('../server.js');

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
