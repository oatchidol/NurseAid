'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Keep this a pure unit test: load only the helper declarations from server.js,
// never the Express/DB/MQTT application or its external dependencies.
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function functionSource(name) {
    const start = serverSource.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} must remain in server.js`);
    const next = serverSource.indexOf('\nfunction ', start + 1);
    assert.notEqual(next, -1, `${name} must be followed by another helper`);
    return serverSource.slice(start, next);
}
const helperNames = [
    'classifyVitalRange', 'higherAlertLevel', 'alertLevelRank', 'lowerAlertLevel',
    'classifySpo2Level', 'boundedHysteresisMargin', 'returnVitalRangeWithHysteresis',
    'returnSpo2LevelWithHysteresis', 'applyVitalAlertHysteresis',
    'batteryLowThreshold', 'shouldRaiseBatteryLowAlert', 'shouldResolveBatteryLowAlert'
];
const helpers = vm.runInNewContext(
    `${helperNames.map(functionSource).join('\n')}\n({ classifyVitalRange, returnVitalRangeWithHysteresis, applyVitalAlertHysteresis, shouldRaiseBatteryLowAlert, shouldResolveBatteryLowAlert })`,
    { ALERT_DEESCALATE_DWELL_MS: 120000, vitalAlertHysteresisState: new Map(), Map, Set, Object, Number, Date }
);
const {
    classifyVitalRange, returnVitalRangeWithHysteresis, applyVitalAlertHysteresis,
    shouldRaiseBatteryLowAlert, shouldResolveBatteryLowAlert
} = helpers;

const DWELL_MS = 120000;

function hrMetric(value) {
    return {
        key: 'hr', available: true, cause: `HR=${value} bpm`,
        rawLevel: classifyVitalRange(value, 50, 60, 110, 120),
        returnLevel: classifyVitalRange(value, 52, 62, 108, 118)
    };
}

function tempMetric(value) {
    return {
        key: 'temp', available: true, cause: `Temp=${value}°C`,
        rawLevel: classifyVitalRange(value, 35.5, 36, 37, 37.5),
        returnLevel: classifyVitalRange(value, 35.7, 36.2, 36.8, 37.3)
    };
}

function at(stateByMac, nowMs, metrics, connected = true, worn = true) {
    return applyVitalAlertHysteresis('aa:bb:cc:dd:ee:ff', metrics, {
        stateByMac, nowMs, dwellMs: DWELL_MS, connected, worn
    });
}

test('normal to critical escalates immediately without dwell', () => {
    const state = new Map();
    assert.equal(at(state, 0, [hrMetric(72)]).alertLevel, 'normal');
    const result = at(state, 1, [hrMetric(47)]);
    assert.equal(result.alertLevel, 'critical');
    assert.match(result.alertCauses[0], /Critical/);
});

test('critical to warning waits for the full dwell period', () => {
    const state = new Map();
    assert.equal(at(state, 0, [hrMetric(47)]).alertLevel, 'critical');
    assert.equal(at(state, 1, [hrMetric(55)]).alertLevel, 'critical');
    assert.equal(at(state, DWELL_MS, [hrMetric(55)]).alertLevel, 'critical');
    assert.equal(at(state, DWELL_MS + 1, [hrMetric(55)]).alertLevel, 'warning');
});

test('a return to critical resets a pending de-escalation dwell', () => {
    const state = new Map();
    at(state, 0, [hrMetric(47)]);
    at(state, 1, [hrMetric(55)]);
    assert.equal(at(state, 60000, [hrMetric(47)]).alertLevel, 'critical');
    assert.equal(at(state, 60001, [hrMetric(55)]).alertLevel, 'critical');
    assert.equal(at(state, 60001 + DWELL_MS - 1, [hrMetric(55)]).alertLevel, 'critical');
    assert.equal(at(state, 60001 + DWELL_MS, [hrMetric(55)]).alertLevel, 'warning');
});

test('HR 49/51 threshold oscillation does not flip the held critical level', () => {
    const state = new Map();
    const levels = [49, 51, 49, 51, 49, 51, 49].map((hr, index) =>
        at(state, index * 15000, [hrMetric(hr)]).alertLevel
    );
    assert.deepEqual(levels, Array(levels.length).fill('critical'));
});

test('offline clears the MAC hysteresis state immediately', () => {
    const state = new Map();
    at(state, 0, [hrMetric(47)]);
    assert.equal(state.size, 1);
    assert.equal(at(state, 1, [hrMetric(47)], false).alertLevel, 'normal');
    assert.equal(state.size, 0);
});

test('three hours of the observed HR and temperature oscillation has fewer than ten level changes', () => {
    const state = new Map();
    let previous = 'normal';
    let changes = 0;
    for (let nowMs = 0, tick = 0; nowMs < 3 * 60 * 60 * 1000; nowMs += 15000, tick += 1) {
        const result = at(state, nowMs, [hrMetric(tick % 2 ? 52 : 47), tempMetric(tick % 2 ? 35.6 : 35.4)]);
        if (result.alertLevel !== previous) changes += 1;
        previous = result.alertLevel;
    }
    assert.ok(changes < 10, `expected fewer than 10 level changes, got ${changes}`);
    assert.equal(changes, 1, 'the held critical state should remain stable');
});

test('battery 15% at threshold 20% is eligible for a warning insert', () => {
    assert.equal(shouldRaiseBatteryLowAlert({ battery: 15 }, { battery_low_threshold: 20 }), true);
});

test('battery 25% at threshold 20% does not insert', () => {
    assert.equal(shouldRaiseBatteryLowAlert({ battery: 25 }, { battery_low_threshold: 20 }), false);
});

test("stale battery placeholder '--' does not insert or throw", () => {
    assert.doesNotThrow(() => {
        assert.equal(shouldRaiseBatteryLowAlert({ battery: '--' }, { battery_low_threshold: 20 }), false);
    });
});

test('an existing open alert prevents a duplicate battery_low insert', () => {
    assert.equal(shouldRaiseBatteryLowAlert({ battery: 15 }, { battery_low_threshold: 20 }, true), false);
});

test('battery low decision uses the custom threshold for this device', () => {
    assert.equal(shouldRaiseBatteryLowAlert({ battery: 15 }, { battery_low_threshold: 10 }), false);
    assert.equal(shouldRaiseBatteryLowAlert({ battery: 10 }, { battery_low_threshold: 10 }), true);
});

test('a fresh battery recovery resolves only the low state, so a later low reading is new', () => {
    const settings = { battery_low_threshold: 20 };
    let batteryLowOpen = false;

    assert.equal(shouldRaiseBatteryLowAlert({ battery: 15 }, settings, batteryLowOpen), true);
    batteryLowOpen = true;
    assert.equal(shouldResolveBatteryLowAlert({ battery: 80 }, settings), true);
    batteryLowOpen = false;
    assert.equal(shouldRaiseBatteryLowAlert({ battery: 15 }, settings, batteryLowOpen), true,
        'after recovery resolves battery_low, a later low packet is eligible for a new alert');
});

test('a narrow custom vital range disables crossed return thresholds and can de-escalate', () => {
    // 50/51/52/53 with a requested margin of 2 caps at 0.5, which still
    // collapses the return warning band. The helper must use raw thresholds,
    // rather than classify normal readings as critical forever.
    assert.equal(returnVitalRangeWithHysteresis(51.5, 50, 51, 52, 53, 2), 'normal');

    const state = new Map();
    const tightMetric = value => ({
        key: 'hr', available: true, cause: `HR=${value} bpm`,
        rawLevel: classifyVitalRange(value, 50, 51, 52, 53),
        returnLevel: returnVitalRangeWithHysteresis(value, 50, 51, 52, 53, 2)
    });
    assert.equal(at(state, 0, [tightMetric(49)]).alertLevel, 'critical');
    assert.equal(at(state, 1, [tightMetric(51.5)]).alertLevel, 'critical');
    assert.equal(at(state, DWELL_MS + 1, [tightMetric(51.5)]).alertLevel, 'normal');
});
