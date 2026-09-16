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
    buildLiveSnapshot,
    shouldRaiseOfflineAlert
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
    assert.equal(snap.connectivityLastSeenMs, null, 'an implausibly future packet must not become the offline clock');
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

const MEDIUM_OFFLINE_SETTINGS = { offline_threshold_minutes: 4 };

function offlineStatusFromSnapshot(snapshot, nowMs) {
    const age = timestampMs => timestampMs === null
        ? null
        : Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
    return {
        status: snapshot.connected ? 'Online' : 'Offline',
        lastSeenSeconds: age(snapshot.lastSeenMs),
        connectivityLastSeenSeconds: age(snapshot.connectivityLastSeenMs)
    };
}

test('production regression: 15-minute connectivity loss with 2-minute battery raises medium offline alert', () => {
    const now = Date.UTC(2026, 8, 15, 6, 16, 0); // 13:16 ICT
    const sensor = {
        status: { value: WEARABLE_STATUS_WORN, timestampMs: now - (900 * 1000) },
        battery: { value: 0, timestampMs: now - (120 * 1000) }
    };
    const snapshot = buildLiveSnapshot(sensor, now, BASE);
    const status = offlineStatusFromSnapshot(snapshot, now);

    assert.equal(snapshot.connected, false, '900 seconds exceeds the 600-second clinical window');
    assert.equal(snapshot.battery, 0, 'the independently fresh 0% battery is retained');
    assert.equal(status.connectivityLastSeenSeconds, 900,
        'offline timing must use the actual connectivity timestamp, not the 120-second battery');
    assert.notEqual(status.connectivityLastSeenSeconds, null);
    assert.notEqual(status.connectivityLastSeenSeconds, status.lastSeenSeconds);
    assert.equal(status.lastSeenSeconds, 120);
    assert.equal(shouldRaiseOfflineAlert(status, MEDIUM_OFFLINE_SETTINGS), true);
});

test('production regression: 25-minute connectivity loss is not hidden by a 60-second battery', () => {
    const now = Date.UTC(2026, 8, 15, 6, 26, 0); // 13:26 ICT
    const sensor = {
        heart: { value: 72, timestampMs: now - (1500 * 1000) },
        battery: { value: 0, timestampMs: now - (60 * 1000) }
    };
    const status = offlineStatusFromSnapshot(buildLiveSnapshot(sensor, now, BASE), now);

    assert.equal(status.status, 'Offline');
    assert.equal(status.connectivityLastSeenSeconds, 1500);
    assert.equal(status.lastSeenSeconds, 60);
    assert.equal(shouldRaiseOfflineAlert(status, MEDIUM_OFFLINE_SETTINGS), true);
});

test('production regression: missing connectivity does not fall back to fresh battery lastSeen', () => {
    const now = Date.UTC(2026, 8, 15, 6, 31, 0); // 13:31 ICT
    const sensor = { battery: { value: 0, timestampMs: now - (60 * 1000) } };
    const status = offlineStatusFromSnapshot(buildLiveSnapshot(sensor, now, BASE), now);

    assert.equal(status.status, 'Offline');
    assert.equal(status.connectivityLastSeenSeconds, null, 'no connectivity point is distinct from battery-only contact');
    assert.equal(status.lastSeenSeconds, 60);
    assert.equal(shouldRaiseOfflineAlert(status, MEDIUM_OFFLINE_SETTINGS, 240), true,
        'null connectivity must take the Offline/startup-grace path, not use lastSeenSeconds');
});

test('fresh 60-second connectivity never raises a medium offline alert, regardless of battery age', () => {
    const now = Date.UTC(2026, 8, 15, 6, 36, 0); // 13:36 ICT
    for (const batteryAgeSeconds of [0, 120, 1800, 3600, null]) {
        const sensor = {
            status: { value: WEARABLE_STATUS_WORN, timestampMs: now - (60 * 1000) }
        };
        if (batteryAgeSeconds !== null) {
            sensor.battery = { value: 0, timestampMs: now - (batteryAgeSeconds * 1000) };
        }
        const status = offlineStatusFromSnapshot(buildLiveSnapshot(sensor, now, BASE), now);
        assert.equal(status.connectivityLastSeenSeconds, 60);
        assert.equal(shouldRaiseOfflineAlert(status, MEDIUM_OFFLINE_SETTINGS), false,
            `battery age ${batteryAgeSeconds} must not create a false offline alert`);
    }
});

test('callers without connectivityLastSeenSeconds retain legacy lastSeenSeconds behavior', () => {
    const settings = MEDIUM_OFFLINE_SETTINGS;
    assert.equal(shouldRaiseOfflineAlert({ status: 'Offline', lastSeenSeconds: 239 }, settings), false);
    assert.equal(shouldRaiseOfflineAlert({ status: 'Offline', lastSeenSeconds: 240 }, settings), true);
    assert.equal(shouldRaiseOfflineAlert({ status: 'Online', lastSeenSeconds: 240 }, settings), true,
        'legacy callers were evaluated from lastSeenSeconds without a status gate');
    assert.equal(shouldRaiseOfflineAlert({ status: 'Offline', lastSeenSeconds: null }, settings, 239), false);
    assert.equal(shouldRaiseOfflineAlert({ status: 'Offline', lastSeenSeconds: null }, settings, 240), true);
});

test('production timeline: 28 sparse points over 194 minutes still creates an offline-alert interval', () => {
    // 21:02:02:06:9F:20, bed 3_20, medium priority: the real 15 Sep trace had
    // 4 heart, 11 temperature, 11 status, 1 RSSI and 1 battery point.  The
    // final connectivity point is followed 15 minutes later by a fresh 0%
    // battery-only point: the exact 10–30 minute failure window.
    const startMs = Date.UTC(2026, 8, 15, 6, 1, 0); // 13:01 ICT
    const durationSeconds = 194 * 60;
    const connectivityKinds = [
        ...Array(4).fill('heart'), ...Array(11).fill('temp'),
        ...Array(11).fill('status'), 'rssi'
    ];
    const points = connectivityKinds.map((kind, index) => ({
        kind,
        timestampMs: startMs + Math.round((index * 179 * 60 * 1000) / (connectivityKinds.length - 1))
    }));
    points.push({ kind: 'battery', timestampMs: startMs + (194 * 60 * 1000) });
    points.sort((left, right) => left.timestampMs - right.timestampMs);
    assert.equal(points.length, 28);

    const sensor = {};
    const offlineAlertTimes = [];
    for (const point of points) {
        const nowMs = point.timestampMs;
        const value = point.kind === 'battery' ? 0
            : point.kind === 'status' ? WEARABLE_STATUS_WORN
                : point.kind === 'rssi' ? -70 : point.kind === 'temp' ? 36.8 : 72;
        sensor[point.kind] = { value, timestampMs: point.timestampMs };
        const status = offlineStatusFromSnapshot(buildLiveSnapshot(sensor, nowMs, BASE), nowMs);
        if (status.status === 'Offline' && shouldRaiseOfflineAlert(status, MEDIUM_OFFLINE_SETTINGS)) {
            offlineAlertTimes.push(Math.floor((nowMs - startMs) / 1000));
        }
    }

    assert.ok(offlineAlertTimes.length > 0,
        'the sparse production-shaped trace must contain at least one alertable Offline interval');
    assert.deepEqual(offlineAlertTimes, [durationSeconds],
        'the final fresh-battery / lost-connectivity observation must be alertable immediately');
});
