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
    // nurseaid_esp32.ino: PRIORITY_MEDIUM_INTERVAL_MS = 1 min, LOW = 5 min.
    assert.equal(PRIORITY_REST_SECONDS.high, 0);
    assert.equal(PRIORITY_REST_SECONDS.medium, 60);
    assert.equal(PRIORITY_REST_SECONDS.low, 300);
});

test('priorityRestSeconds is case and whitespace tolerant and defaults to high', () => {
    assert.equal(priorityRestSeconds('LOW'), 300);
    assert.equal(priorityRestSeconds('  Medium '), 60);
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
    assert.equal(medium.status, 240);     // 60 rest + 180 margin
    assert.equal(medium.presence, 240);
    assert.equal(medium.clinical, 600);   // base already larger, keep it
    const low = freshnessPolicyForPriority(BASE, 'low');
    assert.equal(low.status, 480);        // 300 rest + 180 margin
    assert.equal(low.presence, 480);
    assert.equal(low.clinical, 600);      // base still larger at this rest
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
    assert.equal(offlineThresholdMinutesForPriority(settings, 'medium'), 4);  // ceil(240/60)
    assert.equal(offlineThresholdMinutesForPriority(settings, 'low'), 8);     // ceil(480/60)
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

test('at the current rest intervals the base window already covers a whole rest', () => {
    // 8 minutes = 480s, exactly the low rest floor (300 rest + 180 margin) and
    // the worst case a scheduled rest can produce -- still inside the 600s base
    // clinical window. At these intervals the floor never exceeds that base, so
    // widening is a no-op for vitals: a resting watch is carried to the very end
    // of its rest by the unadjusted window alone.
    const now = Date.now();
    const eightMinutesAgo = now - (8 * 60 * 1000);
    const sensor = {
        status: { value: WEARABLE_STATUS_RESTING, timestampMs: eightMinutesAgo },
        heart: { value: 68, timestampMs: eightMinutesAgo }
    };
    const asLow = buildLiveSnapshot(sensor, now, freshnessPolicyForPriority(BASE, 'low'));
    assert.equal(asLow.connected, true, 'inside the 600s window');
    assert.equal(asLow.hr, 68);

    const asHigh = buildLiveSnapshot(sensor, now, BASE);
    assert.equal(asHigh.connected, true, 'same window, so high reads the same');
});

test('presence is the only window a rest still stretches at these intervals', () => {
    // Lock in which dimension the widening actually moves, so a future change to
    // PRIORITY_REST_SECONDS is forced through this test. clinical, quality and the
    // effective status window (max(status, clinical)) are all pinned at the 600s
    // base for every priority; only presence separates them. If a longer rest is
    // restored, clinical starts widening again and the Influx query range below
    // has to grow with it -- that coupling is the whole reason this file exists.
    const low = freshnessPolicyForPriority(BASE, 'low');
    const medium = freshnessPolicyForPriority(BASE, 'medium');
    for (const policy of [medium, low]) {
        assert.equal(policy.clinical, BASE.clinical, 'clinical must not widen at this rest');
        assert.equal(policy.quality, BASE.quality, 'quality must not widen at this rest');
        assert.equal(Math.max(policy.status, policy.clinical), 600, 'status window unchanged');
    }
    assert.equal(medium.presence, 240, 'medium stretches presence past the 90s base');
    assert.equal(low.presence, 480, 'low stretches it further');
    assert.ok(low.presence > medium.presence, 'a longer rest must stretch presence further');
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

    // The assertion above only bites while some freshness value exceeds the 600s
    // clinical base. At the current 1/5 minute rests nothing does, so prove the
    // mechanism itself still tracks a widening rather than asserting a premise
    // that today's constants have made false: feed a rest long enough to push
    // the floor past the base and check the window grows to cover it.
    const longRestSeconds = 900;   // a 15 minute rest, as the 10 minute one used to be
    const widened = {
        clinical: Math.max(BASE.clinical, longRestSeconds),
        status: Math.max(BASE.status, longRestSeconds),
        quality: Math.max(BASE.quality, longRestSeconds),
        presence: Math.max(BASE.presence, longRestSeconds)
    };
    const grownWindow = calculateQueryWindowMinutes(widened);
    assert.ok(
        grownWindow > longRestSeconds / 60,
        `a ${longRestSeconds / 60}min rest must grow the query window past it, got ${grownWindow}min`
    );
    assert.ok(grownWindow > windowMinutes, 'a longer rest must widen the range, not leave it flat');
});
