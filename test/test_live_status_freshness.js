'use strict';

// Two ways the live view can show a patient who is not being monitored.
//
// 1. The Pi has no RTC battery and udp/123 is firewalled, so its clock is
//    arbitrary after every boot and gets stepped by hand or by the HTTPS sync
//    timer. A backwards step leaves stored readings in the future, and an
//    unbounded "age <= window" test reads a negative age as the freshest data
//    there is. esp32-status.js got this guard in 8e9c61c; this file locks it in
//    for the live vitals path too.
//
// 2. The status metric said whether the watch is on a wrist, but expired in
//    180s while the vitals it qualifies lived for 600s. In that gap the system
//    had forgotten whether the watch was worn and inferred "worn" from the very
//    readings whose trustworthiness was in question. The gap was widest on high
//    priority -- the sickest patients had the longest exposure.

const test = require('node:test');
const assert = require('node:assert');

const {
    WEARABLE_STATUS_OFF_WRIST,
    WEARABLE_STATUS_WORN,
    freshnessPolicyForPriority,
    buildLiveSnapshot
} = require('../live-status.js');

const BASE = {
    clinical: 600, status: 180, battery: 1800,
    quality: 600, presence: 90, liveHr: 30
};

test('a reading timestamped in the future is corrupt, not the freshest one', () => {
    const now = Date.now();
    const anHourAhead = now + (60 * 60 * 1000);
    const sensor = {
        status: { value: WEARABLE_STATUS_WORN, timestampMs: anHourAhead },
        heart: { value: 72, timestampMs: anHourAhead },
        temp: { value: 36.8, timestampMs: anHourAhead }
    };

    const snap = buildLiveSnapshot(sensor, now, BASE);

    assert.equal(snap.connected, false, 'a future timestamp must not count as contact');
    assert.equal(snap.worn, false, 'nor may it assert the watch is on a wrist');
    assert.equal(snap.hr, '--', 'nor render as a live reading');
    assert.equal(snap.temp, '--');
});

test('a correction-sized backwards step does not blank the ward', () => {
    // nurseaid-httpstime steps this clock backwards whenever it drifts past 2s;
    // the first correction after install was 4.5s. Every point written in the
    // seconds before such a step lands fractionally in the future, and they are
    // real readings. Rejecting them would flip beds to offline after every sync.
    const now = Date.now();
    const justAfterAStep = now + 5000;
    const sensor = {
        status: { value: WEARABLE_STATUS_WORN, timestampMs: justAfterAStep },
        heart: { value: 72, timestampMs: justAfterAStep }
    };

    const snap = buildLiveSnapshot(sensor, now, BASE);

    assert.equal(snap.connected, true, 'sub-second-to-second skew is normal');
    assert.equal(snap.hr, 72);
});

test('status never expires before the vitals it qualifies', () => {
    // 300s is past the 180s status window but inside the 600s clinical window:
    // exactly the gap. The watch's last word was "not on a wrist".
    const now = Date.now();
    const fiveMinutesAgo = now - (300 * 1000);
    const sensor = {
        status: { value: WEARABLE_STATUS_OFF_WRIST, timestampMs: fiveMinutesAgo },
        heart: { value: 72, timestampMs: fiveMinutesAgo }
    };

    const snap = buildLiveSnapshot(sensor, now, BASE);

    assert.equal(snap.explicitOffWrist, true, 'the watch said it was off; that must not time out first');
    assert.equal(snap.worn, false, 'a stale status must never be upgraded to worn by its own vitals');
});

test('no priority gets a window where a vital outlives its status', () => {
    // Regression guard on the inversion itself. Before the fix the gap was
    // 420s on high, 120s on medium and 0s on low -- worst for the patients who
    // need the display to be true.
    for (const priority of ['high', 'medium', 'low']) {
        const policy = freshnessPolicyForPriority(BASE, priority);
        const now = Date.now();
        const justInsideClinical = now - ((policy.clinical - 1) * 1000);
        const sensor = {
            status: { value: WEARABLE_STATUS_OFF_WRIST, timestampMs: justInsideClinical },
            heart: { value: 72, timestampMs: justInsideClinical }
        };

        const snap = buildLiveSnapshot(sensor, now, policy);

        assert.equal(
            snap.worn, false,
            `${priority}: a vital inside the clinical window must never outlive its status`
        );
        assert.equal(
            snap.explicitOffWrist, true,
            `${priority}: the off-wrist verdict must still be in force`
        );
    }
});
