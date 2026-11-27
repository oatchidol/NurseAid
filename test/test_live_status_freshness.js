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
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
    WEARABLE_STATUS_OFF_WRIST,
    WEARABLE_STATUS_WORN,
    freshnessPolicyForPriority,
    calculateQueryWindowMinutes,
    buildLiveSnapshot,
    resolveServedStatuses,
    shouldRaiseOfflineAlert
} = require('../live-status.js');

const BASE = {
    clinical: 600, status: 180, battery: 1800,
    quality: 600, presence: 90, liveHr: 120
};

// Exercise the real server policy parsing and query-to-status mapping, with
// in-memory DB/Influx inputs. This also checks the production hrAvailable gate
// without starting Express, MQTT or a database, or inheriting local .env values.
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function serverSection(startMarker, endMarker) {
    const start = serverSource.indexOf(startMarker);
    const end = serverSource.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `server section ${startMarker} must exist`);
    return serverSource.slice(start, end);
}
const serverPolicySource = serverSection('const parsedLiveFreshness =', 'const parsedInfluxTimeout =');
const queryStatusesSource = serverSection('async function queryLiveStatuses()', 'const readLiveStatuses =');

async function serverHrStatus(ageSeconds, env = {}, statusValue = WEARABLE_STATUS_WORN, priority = 'high') {
    const now = Date.UTC(2026, 10, 2, 0, 0, 0);
    let hrAvailable;
    let clinicalQuery;
    const context = vm.createContext({
        Date: class extends Date { static now() { return now; } },
        process: { env }, SERVER_STARTED_AT_MS: now,
        buildLiveSnapshot, calculateQueryWindowMinutes, freshnessPolicyForPriority,
        normalizeMac: mac => mac.toLowerCase(),
        pool: { query: async sql => ({ rows: sql.includes('FROM nurseaid n')
            ? [{ mac: 'aa:bb:cc:dd:ee:ff', priority, device_type: 'jstyle' }]
            : [] }) },
        influxConfig: { bucket: 'test' },
        queryApi: { collectRows: async sql => {
            if (!sql.includes('ble_heart')) return [];
            clinicalQuery = sql;
            return [['ble_heart', 140], ['ble_temp', 36.8], ['ble_spo2', 98], ['ble_status', statusValue]]
                .map(([_measurement, _value]) => ({
                    mac: 'aa:bb:cc:dd:ee:ff', _measurement, _value, _field: 'value',
                    _time: new Date(now - ageSeconds * 1000).toISOString()
                }));
        } },
        // Alert classification is independent of freshness; inspect the actual
        // availability flag passed to it by queryLiveStatuses.
        alertThresholds: () => ({}),
        classifyVitalRange: () => 'normal', classifySpo2Level: () => 'normal',
        returnVitalRangeWithHysteresis: () => 'normal', returnSpo2LevelWithHysteresis: () => 'normal',
        ALERT_HYSTERESIS_HR_BPM: 2, ALERT_HYSTERESIS_TEMP_C: 0.2, ALERT_HYSTERESIS_SPO2_PCT: 1,
        applyVitalAlertHysteresis: (mac, metrics) => {
            hrAvailable = metrics.find(metric => metric.key === 'hr').available;
            return { alertLevel: 'normal', alertCauses: [] };
        },
        pruneVitalAlertHysteresisState: () => {}
    });
    const [status] = await vm.runInContext(`${serverPolicySource}\n${queryStatusesSource}\nqueryLiveStatuses()`, context);
    const policy = vm.runInContext(`freshnessPolicyForPriority(LIVE_FRESHNESS_POLICY, ${JSON.stringify(priority)})`, context);
    return { status, hrAvailable, policy, clinicalQuery, liveHr: vm.runInContext('LIVE_FRESHNESS_POLICY.liveHr', context) };
}

const PRIORITY_HR_CASES = [
    ['high', 120, [[100, true], [120, true], [130, false]]],
    ['medium', 180, [[170, true], [180, true], [190, false]]],
    ['low', 420, [[400, true], [420, true], [430, false]]]
];
for (const [priority, windowSeconds, cases] of PRIORITY_HR_CASES) {
    for (const [ageSeconds, expectedLive] of cases) {
        test(`${priority} server HR at ${ageSeconds}s has hrLive/hrAvailable=${expectedLive}`, async () => {
            const { status, hrAvailable, liveHr, policy } = await serverHrStatus(ageSeconds, {}, WEARABLE_STATUS_WORN, priority);
            assert.equal(liveHr, 120);
            assert.equal(policy.liveHr, windowSeconds);
            assert.equal(status.hrLive, expectedLive);
            assert.equal(hrAvailable, expectedLive);
            assert.equal(status.dataQuality, expectedLive ? 'live' : 'recent');
            assert.equal(status.hr, 140, 'clinical retention is independent of HR alert freshness');
        });
    }
}

test('snapshot fallback uses 120s and each priority adds only its scheduled rest', () => {
    const now = Date.now();
    for (const ageSeconds of [100, 120, 130, 170, 190, 400, 430]) {
        const sensor = { heart: { value: 72, timestampMs: now - ageSeconds * 1000 } };
        assert.equal(buildLiveSnapshot(sensor, now).hrLive, ageSeconds <= 120);
        for (const [priority, windowSeconds] of PRIORITY_HR_CASES) {
            const policy = freshnessPolicyForPriority(BASE, priority);
            assert.equal(buildLiveSnapshot(sensor, now, policy).hrLive, ageSeconds <= windowSeconds);
        }
    }
});

test('LIVE_HR_FRESHNESS_SECONDS overrides the base in both directions before adding rest', async () => {
    for (const override of ['30', '200']) {
        for (const [priority, restSeconds] of [['high', 0], ['medium', 60], ['low', 300]]) {
            const windowSeconds = Number(override) + restSeconds;
            for (const ageSeconds of [windowSeconds, windowSeconds + 1]) {
                const { status, hrAvailable, liveHr, policy } = await serverHrStatus(
                    ageSeconds, { LIVE_HR_FRESHNESS_SECONDS: override }, WEARABLE_STATUS_WORN, priority);
                assert.equal(liveHr, Number(override));
                assert.equal(policy.liveHr, windowSeconds);
                assert.equal(status.hrLive, ageSeconds <= windowSeconds);
                assert.equal(hrAvailable, ageSeconds <= windowSeconds);
            }
        }
    }
});

test('invalid HR env overrides fall back to a 120s base', async () => {
    for (const override of ['', 'invalid', '0', '-1', 'Infinity']) {
        for (const [priority, windowSeconds] of PRIORITY_HR_CASES) {
            for (const ageSeconds of [windowSeconds, windowSeconds + 1]) {
                const { status, hrAvailable, liveHr } = await serverHrStatus(
                    ageSeconds, { LIVE_HR_FRESHNESS_SECONDS: override }, WEARABLE_STATUS_WORN, priority);
                assert.equal(liveHr, 120);
                assert.equal(status.hrLive, ageSeconds <= windowSeconds);
                assert.equal(hrAvailable, ageSeconds <= windowSeconds);
            }
        }
    }
});

test('priority HR is capped at the widened clinical retention without mutating the shared base', () => {
    const base = Object.freeze({ ...BASE, clinical: 100, liveHr: 200 });
    for (const [priority, clinical] of [['high', 100], ['medium', 240], ['low', 480]]) {
        const policy = freshnessPolicyForPriority(base, priority);
        assert.notStrictEqual(policy, base);
        assert.equal(policy.clinical, clinical);
        assert.equal(policy.liveHr, clinical);
        policy.liveHr = 1;
        assert.equal(base.liveHr, 200);
        assert.equal(base.clinical, 100);
    }
    const implicitMedium = freshnessPolicyForPriority(BASE);
    assert.equal(implicitMedium.liveHr, 180);
});

test('production Influx query covers every priority HR window, including custom retention', async () => {
    for (const env of [{}, { LIVE_VITAL_FRESHNESS_SECONDS: '120', LIVE_HR_FRESHNESS_SECONDS: '900' }]) {
        for (const [priority] of PRIORITY_HR_CASES) {
            const { policy, clinicalQuery } = await serverHrStatus(100, env, WEARABLE_STATUS_WORN, priority);
            const [, minutes] = clinicalQuery.match(/range\(start: -(\d+)m\)/);
            assert.ok(Number(minutes) * 60 > policy.liveHr);
            assert.ok(policy.liveHr <= policy.clinical);
        }
    }
});

test('custom clinical retention bounds live HR and keeps off-wrist status authoritative', async () => {
    const env = { LIVE_VITAL_FRESHNESS_SECONDS: '120', LIVE_STATUS_FRESHNESS_SECONDS: '60', LIVE_HR_FRESHNESS_SECONDS: '900' };
    const { status, hrAvailable, liveHr } = await serverHrStatus(200, env);
    assert.equal(liveHr, 120);
    assert.equal(status.hrLive, false);
    assert.equal(hrAvailable, false);
    assert.equal(status.hr, '--');
    const offWrist = await serverHrStatus(100, env, WEARABLE_STATUS_OFF_WRIST);
    assert.equal(offWrist.status.isWorn, false);
    assert.equal(offWrist.hrAvailable, false);
    const now = Date.now();
    assert.equal(buildLiveSnapshot({ heart: { value: 72, timestampMs: now - 200000 } }, now,
        { clinical: 120, liveHr: 900 }).hrLive, false, 'direct callers also respect clinical retention');
});

test('monitor HR warning colors respect server HR freshness', () => {
    const hrChecks = serverSection('const isHrCrit =', 'const isSpo2Crit =');
    const limits = { hrMin: 50, hrWarningMin: 60, hrWarningMax: 110, hrMax: 120 };
    for (const hr of [140, 115]) {
        for (const hrLive of [true, false]) {
            const result = vm.runInNewContext(`${hrChecks}\n({ isHrCrit, isHrWarn })`, {
                canEvaluateVitals: true, p: { hr, hrLive }, limit: limits
            });
            assert.equal(result.isHrCrit, hrLive && hr === 140);
            assert.equal(result.isHrWarn, hrLive && hr === 115);
        }
    }
});

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

test('resolveServedStatuses keeps recent cached vitals during a brief stale grace window', () => {
    const cached = [{ mac: '21:02:02:06:9F:20', hr: 78, spo2: 98, temp: 36.7, status: 'Online' }];

    const fresh = resolveServedStatuses({ value: cached, stale: false, ageMs: 0 }, 60000);
    assert.equal(fresh.unavailable, false);
    assert.equal(fresh.statuses[0].hr, 78);

    const withinGrace = resolveServedStatuses({ value: cached, stale: true, ageMs: 15000 }, 60000);
    assert.equal(withinGrace.unavailable, false);
    assert.equal(withinGrace.statuses[0].hr, 78);
    assert.equal(withinGrace.statuses[0].spo2, 98);

    const pastGrace = resolveServedStatuses({ value: cached, stale: true, ageMs: 65000 }, 60000);
    assert.equal(pastGrace.unavailable, true);
    assert.equal(pastGrace.statuses[0].hr, '--');
    assert.equal(pastGrace.statuses[0].status, 'Unavailable');
});
