'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildLiveSnapshot,
    createSingleFlightCache,
    createResilientSingleFlightCache,
    markStatusesUnavailable
} = require('./live-status');

const NOW = 1_000_000;
const entry = (value, ageSeconds = 0) => ({ value, timestampMs: NOW - ageSeconds * 1000 });

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