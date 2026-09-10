'use strict';

// A watch on medium/low priority is disconnected on purpose between
// measurements so its battery lasts. Before this behaviour existed the node
// published a burst of zeroes on every disconnect, which the dashboard could
// not tell apart from a watch that had actually fallen off. These tests lock
// in the contract that makes a scheduled rest invisible to the existing UI
// while leaving a genuine dropout exactly as loud as it was.

const test = require('node:test');
const assert = require('node:assert');

const {
    WEARABLE_STATUS_OFF_WRIST,
    WEARABLE_STATUS_WORN,
    WEARABLE_STATUS_RESTING,
    PRIORITY_REST_SECONDS,
    priorityRestSeconds,
    freshnessPolicyForPriority,
    offlineThresholdMinutesForPriority,
    buildLiveSnapshot
} = require('../live-status.js');

const BASE = {
    clinical: 600, status: 180, battery: 1800,
    quality: 600, presence: 90, liveHr: 30
};

test('status codes keep the values the firmware publishes', () => {
    assert.equal(WEARABLE_STATUS_OFF_WRIST, 0);
    assert.equal(WEARABLE_STATUS_WORN, 1);
    assert.equal(WEARABLE_STATUS_RESTING, 2);
});

test('rest intervals mirror the firmware PRIORITY_* constants', () => {
    // nurseaid_esp32.ino: PRIORITY_MEDIUM_INTERVAL_MS = 5 min, LOW = 10 min.
    assert.equal(PRIORITY_REST_SECONDS.high, 0);
    assert.equal(PRIORITY_REST_SECONDS.medium, 300);
    assert.equal(PRIORITY_REST_SECONDS.low, 600);
});

test('priorityRestSeconds is case and whitespace tolerant and defaults to high', () => {
    assert.equal(priorityRestSeconds('LOW'), 600);
    assert.equal(priorityRestSeconds('  Medium '), 300);
    assert.equal(priorityRestSeconds('high'), 0);
    assert.equal(priorityRestSeconds(null), 0);
    assert.equal(priorityRestSeconds(undefined), 0);
    assert.equal(priorityRestSeconds('nonsense'), 0);
});

test('high priority gets the same values back, as a copy not the shared object', () => {
    // A fleet that never sets priority must behave exactly as before...
    assert.deepEqual(freshnessPolicyForPriority(BASE, 'high'), BASE);
    assert.deepEqual(freshnessPolicyForPriority(BASE, null), BASE);
    // ...but the caller must never be handed the shared global policy itself,
    // or a mutation downstream would retune staleness for every patient.
    assert.notStrictEqual(freshnessPolicyForPriority(BASE, 'high'), BASE);
    const copy = freshnessPolicyForPriority(BASE, 'high');
    copy.clinical = 1;
    assert.equal(BASE.clinical, 600, 'mutating the result must not touch the base');
});

test('medium and low widen the windows past their rest interval', () => {
    const medium = freshnessPolicyForPriority(BASE, 'medium');
    assert.equal(medium.status, 480);     // 300 rest + 180 margin
    assert.equal(medium.presence, 480);
    assert.equal(medium.clinical, 600);   // base already larger, keep it
    const low = freshnessPolicyForPriority(BASE, 'low');
    assert.equal(low.status, 780);        // 600 rest + 180 margin
    assert.equal(low.presence, 780);
    assert.equal(low.clinical, 780);      // now exceeds the 600 base
});

test('widening never shortens a window and leaves battery and liveHr alone', () => {
    const low = freshnessPolicyForPriority(BASE, 'low');
    for (const key of ['clinical', 'status', 'quality', 'presence']) {
        assert.ok(low[key] >= BASE[key], `${key} must not shrink`);
    }
    assert.equal(low.battery, BASE.battery);
    assert.equal(low.liveHr, BASE.liveHr, 'a resting watch is genuinely not streaming');
});

test('offline threshold rises to cover a rest but never drops below the operator value', () => {
    const settings = { offline_threshold_minutes: 2 };
    assert.equal(offlineThresholdMinutesForPriority(settings, 'high'), 2);
    assert.equal(offlineThresholdMinutesForPriority(settings, 'medium'), 8);  // ceil(480/60)
    assert.equal(offlineThresholdMinutesForPriority(settings, 'low'), 13);    // ceil(780/60)
    // An operator who deliberately set a longer threshold keeps it.
    assert.equal(offlineThresholdMinutesForPriority({ offline_threshold_minutes: 30 }, 'low'), 30);
    // And the helper still respects the 60 minute ceiling.
    assert.equal(offlineThresholdMinutesForPriority({ offline_threshold_minutes: 999 }, 'low'), 60);
});

test('a resting watch reads as worn and NOT as off-wrist', () => {
    const now = Date.now();
    const sensor = {
        status: { value: WEARABLE_STATUS_RESTING, timestampMs: now - 1000 },
        heart: { value: 72, timestampMs: now - 1000 }
    };
    const snap = buildLiveSnapshot(sensor, now, BASE);
    assert.equal(snap.worn, true, 'the watch is still on the patient');
    assert.equal(snap.explicitOffWrist, false, 'a rest must not blank the vitals');
    assert.equal(snap.connected, true);
    assert.equal(snap.hr, 72, 'the last real reading stays on screen');
});

test('a real dropout still reads as off-wrist', () => {
    const now = Date.now();
    const sensor = {
        status: { value: WEARABLE_STATUS_OFF_WRIST, timestampMs: now - 1000 },
        heart: { value: 0, timestampMs: now - 1000 }
    };
    const snap = buildLiveSnapshot(sensor, now, BASE);
    assert.equal(snap.explicitOffWrist, true);
    assert.equal(snap.worn, false);
    assert.equal(snap.hr, '--', 'zeroed vitals must not render as a reading');
});

test('a low priority watch slightly overdue is still current, where high priority is stale', () => {
    // 11 minutes: past the 10 minute rest but inside the 3 minute margin, which
    // is the window the margin exists to cover. The base clinical window is 600s,
    // so this is also past what an unadjusted policy would accept.
    const now = Date.now();
    const elevenMinutesAgo = now - (11 * 60 * 1000);
    const sensor = {
        status: { value: WEARABLE_STATUS_RESTING, timestampMs: elevenMinutesAgo },
        heart: { value: 68, timestampMs: elevenMinutesAgo }
    };
    const asLow = buildLiveSnapshot(sensor, now, freshnessPolicyForPriority(BASE, 'low'));
    assert.equal(asLow.connected, true, 'still inside the widened 780s window');
    assert.equal(asLow.hr, 68);

    const asHigh = buildLiveSnapshot(sensor, now, BASE);
    assert.equal(asHigh.connected, false, 'unchanged for high priority: stale past 600s');
});

test('the Influx query range must cover the widest priority window, not the default', () => {
    // Regression guard. The range is computed once at startup from the global
    // policy; if it is not widened too, a reading older than the range is never
    // fetched and the widened freshness silently stops working near the end of
    // every low-priority rest -- the patient blinks offline exactly when the
    // widening was supposed to help.
    const { calculateQueryWindowMinutes } = require('../live-status.js');
    const widest = freshnessPolicyForPriority(BASE, 'low');
    const windowMinutes = calculateQueryWindowMinutes({
        clinical: widest.clinical, status: widest.status,
        quality: widest.quality, presence: widest.presence
    });
    const neededMinutes = Math.max(
        widest.clinical, widest.status, widest.quality, widest.presence
    ) / 60;
    assert.ok(
        windowMinutes > neededMinutes,
        `query window ${windowMinutes}min must exceed the widest freshness ${neededMinutes}min`
    );

    // And the unwidened default must NOT be enough - proving this test bites.
    const naive = calculateQueryWindowMinutes({
        clinical: BASE.clinical, status: BASE.status,
        quality: BASE.quality, presence: BASE.presence
    });
    assert.ok(naive < neededMinutes, 'the old default window was genuinely too short');
});
