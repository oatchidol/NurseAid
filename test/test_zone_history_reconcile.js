'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldBridge, buildPlan } = require('../scripts/reconcile-zone-history');

const at = seconds => new Date(1_700_000_000_000 + seconds * 1000);
const row = (id, board, begin, end, mac = 'A') => ({
    id: String(id), mac, board_mac: board, zone_label: board ? 'Ward A' : null,
    ward_id: board ? 1 : null, match_state: board ? 'expected' : 'unknown',
    started_at: at(begin), ended_at: end == null ? null : at(end)
});
const board = 'F0:F5:BD:A1:C5:8C';
const other = '48:27:E2:B7:89:C4';

test('scheduled rest: A-unknown-A bridges at medium priority', () => {
    const rows = [row(1, board, 0, 60), row(2, null, 61, 200), row(3, board, 201, 300)];
    assert.equal(shouldBridge(...rows, 'medium'), true);
    assert.deepEqual(buildPlan(rows, new Map([['A', 'medium']])), {
        updates: [{ id: '1', ended_at: at(300) }],
        deletes: ['2', '3'], bridges: 1
    });
});

test('repeated short rests coalesce into one interval', () => {
    const rows = [row(1, board, 0, 60), row(2, null, 61, 110),
        row(3, board, 111, 180), row(4, null, 181, 240), row(5, board, 241, 300)];
    assert.deepEqual(buildPlan(rows).deletes, ['2', '3', '4', '5']);
    assert.deepEqual(buildPlan(rows).updates, [{ id: '1', ended_at: at(300) }]);
});

test('a transition to another receiver is never inferred away', () => {
    const rows = [row(1, board, 0, 60), row(2, null, 61, 110), row(3, other, 111, 180)];
    assert.deepEqual(buildPlan(rows), { updates: [], deletes: [], bridges: 0 });
});

test('do not merge unknown lasting beyond the allowed priority window', () => {
    const rows = [row(1, board, 0, 60), row(2, null, 61, 300), row(3, board, 301, 380)];
    assert.equal(shouldBridge(...rows, 'high'), false);
    assert.equal(shouldBridge(...rows, 'medium'), true);
});

test('do not merge nonadjacent snapshots or unconfirmed last-known open rows', () => {
    const far = [row(1, board, 0, 60), row(2, null, 95, 110), row(3, board, 111, 200)];
    assert.equal(shouldBridge(...far, 'medium'), false);
    const open = [row(1, board, 0, 60), row(2, null, 61, null)];
    assert.deepEqual(buildPlan(open), { updates: [], deletes: [], bridges: 0 });
});

test('do not bridge through changed ward or status classifications', () => {
    const rows = [row(1, board, 0, 60), row(2, null, 61, 110), row(3, board, 111, 200)];
    rows[2].ward_id = 2;
    assert.equal(shouldBridge(...rows), false);
    rows[2].ward_id = 1;
    rows[2].zone_label = 'Ward B';
    assert.equal(shouldBridge(...rows), false);
});
