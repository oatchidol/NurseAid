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
