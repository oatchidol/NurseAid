const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { shouldRenewSession, signSessionToken } = require('../server.js');

const now = 1_000_000;

test('session is not renewed while more than half its life remains', () => {
    assert.equal(shouldRenewSession({ exp: now + 5 * 3600 }, now), false);
});

test('session is renewed once less than half its life remains', () => {
    assert.equal(shouldRenewSession({ exp: now + 3 * 3600 }, now), true);
    assert.equal(shouldRenewSession({ exp: now - 1 }, now), true);
});

test('missing exp never renews', () => {
    assert.equal(shouldRenewSession({}, now), false);
    assert.equal(shouldRenewSession(null, now), false);
});

test('signSessionToken issues an 8h token carrying the session version', () => {
    const token = signSessionToken({ id: 1, username: 'u', full_name: 'U', role: 'viewer', session_version: 3 });
    const claims = jwt.verify(token, process.env.SESSION_SECRET);
    assert.equal(claims.sessionVersion, 3);
    assert.equal(claims.exp - claims.iat, 8 * 3600);
});
