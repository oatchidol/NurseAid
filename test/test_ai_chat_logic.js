'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    AI_TOOLS,
    aiBedBrief,
    aiBedLabel,
    aiFindStatusByBed,
    aiMatchesIssue,
    aiToolTraceLabel,
    aiToolResultToString,
    cleanAiText
} = require('../server.js');

const statuses = [
    { bed_no: '5', name: 'สมชาย', hr: 88, spo2: 97, temp: 36.8, battery: 74, status: 'Online', isWorn: true, dataQuality: 'ok', alertLevel: 'normal' },
    { bed_no: '05B', name: 'สมหญิง', hr: 132, spo2: 89, temp: 38.4, battery: 12, status: 'Online', isWorn: false, dataQuality: 'stale', telemetryStale: true, alertLevel: 'critical' },
    { bed_no: '12', name: null, hr: '--', spo2: '--', temp: '--', battery: '--', status: 'Offline', dataQuality: 'unavailable', alertLevel: 'warning' }
];

test('AI_TOOLS exposes exactly the three lookup tools the assistant may call', () => {
    assert.deepEqual(AI_TOOLS.map(tool => tool.function.name), ['search_beds', 'get_bed_vitals', 'get_bed_trend']);
    AI_TOOLS.forEach(tool => {
        assert.equal(tool.type, 'function');
        assert.equal(tool.function.parameters.type, 'object');
        assert.equal(tool.function.parameters.additionalProperties, false);
        assert.ok(tool.function.description.length > 20, `${tool.function.name} needs a usable description`);
    });
    // get_bed_trend is the only tool that cannot run without arguments.
    const trend = AI_TOOLS.find(tool => tool.function.name === 'get_bed_trend').function;
    assert.deepEqual(trend.parameters.required, ['bed', 'hours']);
    assert.deepEqual(trend.parameters.properties.hours.enum, [1, 6, 12, 24, 72, 168]);
});

test('aiBedLabel falls back to a dash rather than emitting "undefined" to the model', () => {
    assert.equal(aiBedLabel({ bed_no: ' 7 ' }), '7');
    assert.equal(aiBedLabel({}), '-');
    assert.equal(aiBedLabel({ bed_no: null }), '-');
});

test('aiFindStatusByBed resolves the loose bed labels a model actually emits', () => {
    assert.equal(aiFindStatusByBed(statuses, '5').name, 'สมชาย');
    assert.equal(aiFindStatusByBed(statuses, ' 5 ').name, 'สมชาย');
    assert.equal(aiFindStatusByBed(statuses, 'เตียง 5').name, 'สมชาย');
    assert.equal(aiFindStatusByBed(statuses, '05b').name, 'สมหญิง');
    assert.equal(aiFindStatusByBed(statuses, '99'), null);
    assert.equal(aiFindStatusByBed(statuses, ''), null);
});

test('aiFindStatusByBed matches a zero-padded label against its unpadded form', () => {
    const padded = [{ bed_no: '07', name: 'เจ็ด' }];
    assert.equal(aiFindStatusByBed(padded, '7').name, 'เจ็ด');
    assert.equal(aiFindStatusByBed(padded, '07').name, 'เจ็ด');
});

test('aiBedBrief renders missing vitals as text, not null, and flags a low battery', () => {
    const healthy = aiBedBrief(statuses[0]);
    assert.equal(healthy.bed, '5');
    assert.equal(healthy.heartRate, '88 bpm');
    assert.equal(healthy.isWorn, 'yes');
    assert.equal(healthy.batteryLow, false);

    const low = aiBedBrief(statuses[1]);
    assert.equal(low.batteryLow, true);
    assert.equal(low.isWorn, 'no');

    const offline = aiBedBrief(statuses[2]);
    assert.equal(offline.heartRate, 'ไม่มีข้อมูล');
    assert.equal(offline.battery, 'ไม่มีข้อมูล');
    assert.equal(offline.batteryLow, false);
    assert.equal(offline.isWorn, 'unknown');
    assert.equal(offline.patient, null);
});

test('aiBedBrief never leaks the MAC, HN or ward id into the model context', () => {
    const brief = aiBedBrief({ bed_no: '5', mac: 'AA:BB:CC:DD:EE:FF', hm_number: 'HN-0001', ward_id: 3 });
    const serialised = JSON.stringify(brief).toLowerCase();
    assert.ok(!serialised.includes('aa:bb'));
    assert.ok(!serialised.includes('hn-0001'));
    assert.ok(!Object.prototype.hasOwnProperty.call(brief, 'ward_id'));
});

test('aiMatchesIssue maps each filter to the right data-quality signal', () => {
    const [ok, bad, offline] = statuses.map(aiBedBrief);
    assert.equal(aiMatchesIssue(bad, 'stale'), true);
    assert.equal(aiMatchesIssue(ok, 'stale'), false);
    assert.equal(aiMatchesIssue(bad, 'off_wrist'), true);
    assert.equal(aiMatchesIssue(ok, 'off_wrist'), false);
    assert.equal(aiMatchesIssue(bad, 'low_battery'), true);
    assert.equal(aiMatchesIssue(ok, 'low_battery'), false);
    assert.equal(aiMatchesIssue(offline, 'offline'), true);
    assert.equal(aiMatchesIssue(ok, 'offline'), false);
    // An unrecognised filter must not silently drop every bed.
    assert.equal(aiMatchesIssue(ok, 'something_else'), true);
});

test('aiToolTraceLabel describes each lookup in words a nurse can read', () => {
    assert.equal(aiToolTraceLabel('search_beds', {}), 'ดูรายชื่อเตียงทั้งหมด');
    assert.match(aiToolTraceLabel('search_beds', { alertLevel: 'critical' }), /critical/);
    assert.match(aiToolTraceLabel('get_bed_vitals', { beds: ['5', '12'] }), /5, 12/);
    assert.equal(aiToolTraceLabel('get_bed_vitals', {}), 'อ่านค่าล่าสุดทุกเตียง');
    assert.match(aiToolTraceLabel('get_bed_trend', { bed: '5', hours: 24 }), /เตียง 5.*24/);
    // An unknown tool name must still produce a label, never "undefined".
    assert.equal(aiToolTraceLabel('mystery_tool', {}), 'mystery_tool');
});

test('aiToolResultToString truncates an oversized tool result instead of blowing the context', () => {
    const small = aiToolResultToString({ beds: [] });
    assert.equal(small, '{"beds":[]}');
    const huge = aiToolResultToString({ blob: 'x'.repeat(200000) });
    assert.ok(huge.length < 200000);
    assert.match(huge, /ถูกตัดเพราะยาวเกินไป/);
    assert.equal(aiToolResultToString(undefined), 'null');
});

test('cleanAiText: trims, strips angle brackets, and truncates', () => {
    assert.equal(cleanAiText('  hello  ', 600), 'hello');
    assert.equal(cleanAiText('<script>alert(1)</script>', 600), 'scriptalert(1)/script');
    assert.equal(cleanAiText('a'.repeat(700), 600).length, 600);
});

test('cleanAiText: falsy input becomes an empty string, including the pre-existing 0-is-falsy quirk', () => {
    assert.equal(cleanAiText(null, 600), '');
    assert.equal(cleanAiText(undefined, 600), '');
    // Documented as current behavior, not "fixed" here: String(0 || '') === '' because
    // 0 is falsy. Out of scope for this change -- other call sites may rely on it.
    assert.equal(cleanAiText(0, 600), '');
});
