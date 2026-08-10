'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildLiveSnapshot,
    calculateQueryWindowMinutes,
    createSingleFlightCache,
    createResilientSingleFlightCache,
    markStatusesUnavailable,
    offlineThresholdMinutes,
    shouldRaiseOfflineAlert
} = require('./live-status');

const NOW = 1_000_000;
const entry = (value, ageSeconds = 0) => ({ value, timestampMs: NOW - ageSeconds * 1000 });

test('query windows isolate long-lived battery data from clinical telemetry', () => {
    const clinical = calculateQueryWindowMinutes({ clinical: 600, status: 180, presence: 90 });
    const battery = calculateQueryWindowMinutes({ battery: 1800 });
    assert.equal(clinical, 11);
    assert.equal(battery, 31);
});

test('offline alert threshold is configurable and constrained to safe bounds', () => {
    assert.equal(offlineThresholdMinutes({ offline_threshold_minutes: 2 }), 2);
    assert.equal(offlineThresholdMinutes({ offline_threshold_minutes: 0 }), 1);
    assert.equal(offlineThresholdMinutes({ offline_threshold_minutes: 120 }), 60);
    assert.equal(offlineThresholdMinutes({}), 2);
});

test('offline alert fires after the configured age even while retained vitals keep UI online', () => {
    const settings = { offline_threshold_minutes: 2 };
    assert.equal(shouldRaiseOfflineAlert({ status: 'Online', lastSeenSeconds: 119 }, settings, 600), false);
    assert.equal(shouldRaiseOfflineAlert({ status: 'Online', lastSeenSeconds: 120 }, settings, 600), true);
});

test('fresh off-wrist telemetry does not produce a connection alert', () => {
    const status = { status: 'Online', dataQuality: 'off_wrist', lastSeenSeconds: 10 };
    assert.equal(shouldRaiseOfflineAlert(status, { offline_threshold_minutes: 2 }, 600), false);
});

test('a never-seen paired device gets a startup grace period before offline alerting', () => {
    const status = { status: 'Offline', lastSeenSeconds: null };
    const settings = { offline_threshold_minutes: 2 };
    assert.equal(shouldRaiseOfflineAlert(status, settings, 119), false);
    assert.equal(shouldRaiseOfflineAlert(status, settings, 120), true);
});

test('telemetry service outages and restart recovery never produce device offline alerts', () => {
    assert.equal(shouldRaiseOfflineAlert({ status: 'Unavailable', telemetryStale: true }, {}, 600), false);
    assert.equal(shouldRaiseOfflineAlert({ status: 'Recovering', lastSeenSeconds: 600 }, {}, 600), false);
});

test('fresh status=0 keeps recent values visible but marks device off wrist', () => {
    const result = buildLiveSnapshot({
        status: entry(0),
        heart: entry(72, 20),
        temp: entry(36.5, 20)
    }, NOW, 180);

    assert.equal(result.connected, true);
    assert.equal(result.worn, false);
    assert.equal(result.explicitOffWrist, true);
    assert.equal(result.hr, 72);
    assert.equal(result.temp, 36.5);
});

test('off-wrist state is available to the API layer for suppressing SpO2 and alerts', () => {
    const result = buildLiveSnapshot({ status: entry(0), spo2: entry(98, 20) }, NOW, 180);
    assert.equal(result.explicitOffWrist, true);
    assert.equal(result.worn, false);
    assert.equal(result.spo2, 98);
});

test('stale clinical values are never retained', () => {
    const result = buildLiveSnapshot({ status: entry(0), heart: entry(72, 181) }, NOW, 180);
    assert.equal(result.connected, true);
    assert.equal(result.hr, '--');
    assert.equal(result.vitalLastSeenMs, null);
});

test('fresh vital without a status point is treated as connected and worn', () => {
    const result = buildLiveSnapshot({ heart: entry(68, 5) }, NOW, 180);
    assert.equal(result.connected, true);
    assert.equal(result.worn, true);
    assert.equal(result.hr, 68);
});

test('device is offline when all telemetry is stale', () => {
    const result = buildLiveSnapshot({ status: entry(1, 181), heart: entry(70, 181) }, NOW, 180);
    assert.equal(result.connected, false);
    assert.equal(result.worn, false);
    assert.equal(result.hr, '--');
});

test('recent telemetry from before process startup remains online after restart', () => {
    const result = buildLiveSnapshot({
        status: entry(1, 20),
        heart: entry(72, 20)
    }, NOW, {
        clinical: 600, status: 180, battery: 1800, quality: 600,
        presence: 90, liveHr: 30, sessionStartedAtMs: NOW - 10_000
    });

    assert.equal(result.connected, true);
    assert.equal(result.recoveryPending, false);
    assert.equal(result.hr, 72);
});

test('new RSSI after startup cannot make stale clinical values visible', () => {
    const result = buildLiveSnapshot({
        rssi: entry(-65, 5),
        status: entry(1, 181),
        heart: entry(72, 601)
    }, NOW, {
        clinical: 600, status: 180, battery: 1800, quality: 600,
        presence: 90, liveHr: 30, sessionStartedAtMs: NOW - 10_000
    });

    assert.equal(result.connected, true);
    assert.equal(result.presence, 'present');
    assert.equal(result.hr, '--');
    assert.equal(result.worn, false);
});

test('telemetry received after process startup restores online state', () => {
    const result = buildLiveSnapshot({
        status: entry(1, 5),
        heart: entry(72, 5)
    }, NOW, {
        clinical: 600, status: 180, battery: 1800, quality: 600,
        presence: 90, liveHr: 30, sessionStartedAtMs: NOW - 10_000
    });

    assert.equal(result.connected, true);
    assert.equal(result.recoveryPending, false);
});

test('metric-specific freshness keeps clinical values without treating stale status as fresh', () => {
    const result = buildLiveSnapshot({
        status: entry(1, 181),
        heart: entry(70, 590),
        battery: entry(55, 1700)
    }, NOW, { clinical: 600, status: 180, battery: 1800, quality: 600 });

    assert.equal(result.connected, true);
    assert.equal(result.worn, true);
    assert.equal(result.hr, 70);
    assert.equal(result.battery, 55);
});

test('metric-specific freshness expires clinical values at ten minutes', () => {
    const result = buildLiveSnapshot({
        status: entry(1, 30),
        heart: entry(70, 601)
    }, NOW, { clinical: 600, status: 180, battery: 1800, quality: 600 });

    assert.equal(result.connected, true);
    assert.equal(result.hr, '--');
});

test('fresh battery remains visible but cannot keep a stale device online', () => {
    const result = buildLiveSnapshot({
        status: entry(1, 181),
        battery: entry(55, 1700)
    }, NOW, { clinical: 600, status: 180, battery: 1800, quality: 600 });

    assert.equal(result.connected, false);
    assert.equal(result.battery, 55);
});

test('advertisement RSSI proves presence without proving wear status', () => {
    const result = buildLiveSnapshot({ rssi: entry(-67, 10) }, NOW, {
        clinical: 600, status: 180, battery: 1800, quality: 600, presence: 90, liveHr: 30
    });

    assert.equal(result.connected, true);
    assert.equal(result.presence, 'present');
    assert.equal(result.rssi, -67);
    assert.equal(result.worn, false);
    assert.equal(result.hrLive, false);
});

test('recent HR remains visible but is live-alert eligible only within live SLA', () => {
    const policy = { clinical: 600, status: 180, battery: 1800, quality: 600, presence: 90, liveHr: 30 };
    const live = buildLiveSnapshot({ heart: entry(72, 20) }, NOW, policy);
    const recent = buildLiveSnapshot({ heart: entry(72, 31) }, NOW, policy);

    assert.equal(live.hr, 72);
    assert.equal(live.hrLive, true);
    assert.equal(recent.hr, 72);
    assert.equal(recent.hrLive, false);
    assert.equal(recent.metricAges.hr, 31);
});

test('single-flight cache shares concurrent loads and reuses a fresh result', async () => {
    let calls = 0;
    const read = createSingleFlightCache(async () => {
        calls += 1;
        await new Promise(resolve => setTimeout(resolve, 5));
        return { sequence: calls };
    }, 1000);

    const [first, second] = await Promise.all([read(), read()]);
    const third = await read();
    assert.equal(calls, 1);
    assert.strictEqual(first, second);
    assert.strictEqual(second, third);
});

test('single-flight cache can be force-refreshed', async () => {
    let calls = 0;
    const read = createSingleFlightCache(async () => ++calls, 1000);
    assert.equal(await read(), 1);
    assert.equal(await read({ force: true }), 2);
});

test('resilient cache returns the last successful snapshot after a transient failure', async () => {
    let fail = false;
    const read = createResilientSingleFlightCache(async () => {
        if (fail) throw new Error('InfluxDB timeout');
        return [{ mac: 'AA', hr: 72 }];
    }, 0, 60_000);

    const fresh = await read();
    fail = true;
    const fallback = await read({ force: true });

    assert.equal(fresh.stale, false);
    assert.equal(fallback.stale, true);
    assert.strictEqual(fallback.value, fresh.value);
    assert.match(fallback.error.message, /timeout/);
});

test('resilient cache does not hide an initial loader failure', async () => {
    const read = createResilientSingleFlightCache(async () => { throw new Error('unavailable'); }, 0, 60_000);
    await assert.rejects(read(), /unavailable/);
});

test('unavailable fallback retains identity but never exposes stale clinical values or alerts', () => {
    const [status] = markStatusesUnavailable([{
        mac: 'AA', name: 'Patient', hr: 72, spo2: 98, temp: 36.5,
        status: 'Online', isWorn: true, alertLevel: 'critical', alertCauses: ['HR=140']
    }]);

    assert.equal(status.name, 'Patient');
    assert.equal(status.hr, '--');
    assert.equal(status.spo2, '--');
    assert.equal(status.temp, '--');
    assert.equal(status.status, 'Unavailable');
    assert.equal(status.alertLevel, 'normal');
    assert.deepEqual(status.alertCauses, []);
    assert.equal(status.telemetryStale, true);
});

test('unavailable fallback exposes the age of the last snapshot without exposing its values', () => {
    const now = Date.now();
    const [status] = markStatusesUnavailable([{
        mac: 'AA', hr: 72, spo2: 98, temp: 36.5,
        lastSeenAt: new Date(now - 65_000).toISOString()
    }]);

    assert.equal(status.hr, '--');
    assert.ok(status.lastKnownAgeSeconds >= 64 && status.lastKnownAgeSeconds <= 66);
});
