'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    esp32DeleteBlockedByRecentActivity,
    ESP32_DELETE_MIN_SILENCE_MS
} = require('../server.js');

// A fixed "now" keeps these deterministic — the guard is pure, so the clock is
// injected rather than mocked.
const NOW = Date.parse('2026-08-28T12:00:00.000Z');

test('ESP32_DELETE_MIN_SILENCE_MS is the documented 10 minutes', () => {
    assert.equal(ESP32_DELETE_MIN_SILENCE_MS, 10 * 60 * 1000);
});

test('a board seen moments ago is protected from permanent deletion', () => {
    assert.equal(esp32DeleteBlockedByRecentActivity(new Date(NOW - 1000), NOW), true);
    assert.equal(esp32DeleteBlockedByRecentActivity(new Date(NOW - 60 * 1000), NOW), true);
    assert.equal(esp32DeleteBlockedByRecentActivity(new Date(NOW - 9 * 60 * 1000), NOW), true);
});

test('a board silent for longer than the threshold may be deleted', () => {
    assert.equal(esp32DeleteBlockedByRecentActivity(new Date(NOW - 11 * 60 * 1000), NOW), false);
    assert.equal(esp32DeleteBlockedByRecentActivity(new Date(NOW - 86400 * 1000), NOW), false);
});

test('the threshold boundary is exclusive — exactly 10 minutes of silence is deletable', () => {
    // The guard blocks while age < threshold, so age === threshold must pass.
    assert.equal(
        esp32DeleteBlockedByRecentActivity(new Date(NOW - ESP32_DELETE_MIN_SILENCE_MS), NOW),
        false
    );
    assert.equal(
        esp32DeleteBlockedByRecentActivity(new Date(NOW - ESP32_DELETE_MIN_SILENCE_MS + 1), NOW),
        true
    );
});

test('accepts the shapes pg and JSON actually hand over', () => {
    // node-postgres returns a Date for a TIMESTAMP column; an API round-trip
    // turns the same value into an ISO string. Both must behave identically.
    const asDate = new Date(NOW - 30 * 1000);
    assert.equal(esp32DeleteBlockedByRecentActivity(asDate, NOW), true);
    assert.equal(esp32DeleteBlockedByRecentActivity(asDate.toISOString(), NOW), true);
    assert.equal(esp32DeleteBlockedByRecentActivity(asDate.getTime(), NOW), true);
});

test('a board that never reported is deletable rather than stuck forever', () => {
    // No last_seen_at means the board never proved it was alive, so there is no
    // monitoring history worth protecting. Blocking here would make such a row
    // permanently undeletable through the UI.
    assert.equal(esp32DeleteBlockedByRecentActivity(null, NOW), false);
    assert.equal(esp32DeleteBlockedByRecentActivity(undefined, NOW), false);
    assert.equal(esp32DeleteBlockedByRecentActivity('', NOW), false);
});

test('an unparseable timestamp does not wedge the row as undeletable', () => {
    assert.equal(esp32DeleteBlockedByRecentActivity('not-a-timestamp', NOW), false);
    assert.equal(esp32DeleteBlockedByRecentActivity(NaN, NOW), false);
});

test('a future timestamp is treated as recent activity, not as ancient silence', () => {
    // Clock skew between the Pi and a board must never make a live board look
    // like it has been silent for negative time and become deletable.
    assert.equal(esp32DeleteBlockedByRecentActivity(new Date(NOW + 60 * 1000), NOW), true);
});

test('defaults to the real clock when nowMs is omitted', () => {
    assert.equal(esp32DeleteBlockedByRecentActivity(new Date()), true);
    assert.equal(esp32DeleteBlockedByRecentActivity(new Date(Date.now() - 3600 * 1000)), false);
});
