'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEsp32Topology } = require('../esp32-status');
const { resolveCurrentZone, zoneMatchState, hasZoneStateChanged, resolveDisplayedLocation } = require('../patient-location');

// Build a two-node topology snapshot and parse it through the real parser so
// the test exercises the true integration (raw snapshot -> parseEsp32Topology
// -> resolveCurrentZone) rather than hand-rolled node objects.
const buildTwoNodes = () => {
    const result = parseEsp32Topology({
        topologyReady: true,
        generatedAtEpoch: 123,
        sensors: {
            'F0:F5:BD:A1:C5:8C': {
                status: 'connected',
                nodeId: 'na1c58c',
                ipAddress: '172.16.251.32',
                boardMac: 'F0:F5:BD:A1:C5:8C',
                connectedJstyleCount: 0,
                lastSeenAgeSeconds: 5,
                watches: [{ watchId: '21:02:02:06:9F:7F', status: 'connected' }]
            },
            '48:27:E2:B7:89:C4': {
                status: 'connected',
                nodeId: 'nb789c4',
                ipAddress: '172.16.251.37',
                boardMac: '48:27:E2:B7:89:C4',
                connectedJstyleCount: 0,
                lastSeenAgeSeconds: 9,
                watches: [{ watchId: '21:02:02:06:AA:01', status: 'connected' }]
            }
        }
    }, { sourceAgeSeconds: 2 });
    return result.nodes;
};

test('a wearable connected to exactly one node resolves to that node', () => {
    const nodes = buildTwoNodes();
    const node = resolveCurrentZone(nodes, '21:02:02:06:9F:7F');
    assert.equal(node.boardMac, 'F0:F5:BD:A1:C5:8C');
    assert.equal(node.nodeId, 'na1c58c');
});

test('a wearable not present on any node resolves to null', () => {
    const nodes = buildTwoNodes();
    assert.equal(resolveCurrentZone(nodes, '21:02:02:06:00:00'), null);
});

test('with two nodes a wearable on node B resolves to B, not A', () => {
    const nodes = buildTwoNodes();
    const node = resolveCurrentZone(nodes, '21:02:02:06:AA:01');
    assert.equal(node.boardMac, '48:27:E2:B7:89:C4');
    assert.equal(node.nodeId, 'nb789c4');
});

test('MAC case is ignored when matching', () => {
    const nodes = buildTwoNodes();
    const upper = resolveCurrentZone(nodes, '21:02:02:06:9F:7F'.toUpperCase());
    const lower = resolveCurrentZone(nodes, '21:02:02:06:9f:7f');
    assert.equal(upper.boardMac, 'F0:F5:BD:A1:C5:8C');
    assert.equal(lower.boardMac, 'F0:F5:BD:A1:C5:8C');
});

test('malformed input never throws and resolves to null', () => {
    assert.equal(resolveCurrentZone(null, 'AA:BB'), null);
    assert.equal(resolveCurrentZone([], null), null);
});

test('zoneMatchState: same ward is expected', () => {
    assert.equal(zoneMatchState(3, 3), 'expected');
});

test('zoneMatchState: different ward is a mismatch', () => {
    assert.equal(zoneMatchState(3, 5), 'mismatch');
});

test('zoneMatchState: missing patient ward is unknown, never mismatch', () => {
    assert.equal(zoneMatchState(null, 5), 'unknown');
    assert.equal(zoneMatchState(undefined, 5), 'unknown');
});

test('zoneMatchState: missing node ward is unknown, never mismatch', () => {
    assert.equal(zoneMatchState(3, null), 'unknown');
    assert.equal(zoneMatchState(3, undefined), 'unknown');
});

test('zoneMatchState: string/number ward ids compare by value', () => {
    assert.equal(zoneMatchState('3', 3), 'expected');
});

const zoneState = {
    board_mac: 'F0:F5:BD:A1:C5:8C',
    zone_label: 'Ward A',
    ward_id: 1,
    match_state: 'expected'
};

test('hasZoneStateChanged: no open row opens a new interval', () => {
    assert.equal(hasZoneStateChanged(null, zoneState), true);
    assert.equal(hasZoneStateChanged(undefined, zoneState), true);
});

test('hasZoneStateChanged: identical state does not open a new interval', () => {
    assert.equal(hasZoneStateChanged({ ...zoneState }, zoneState), false);
});

test('hasZoneStateChanged: a different board opens a new interval', () => {
    assert.equal(hasZoneStateChanged({ ...zoneState, board_mac: '48:27:E2:B7:89:C4' }, zoneState), true);
});

test('hasZoneStateChanged: a different zone label opens a new interval', () => {
    assert.equal(hasZoneStateChanged({ ...zoneState, zone_label: 'Ward B' }, zoneState), true);
});

test('hasZoneStateChanged: ward IDs compare by value and detect real changes', () => {
    assert.equal(hasZoneStateChanged({ ...zoneState, ward_id: '1' }, zoneState), false);
    assert.equal(hasZoneStateChanged({ ...zoneState, ward_id: 2 }, zoneState), true);
});

test('hasZoneStateChanged: a different match state opens a new interval', () => {
    assert.equal(hasZoneStateChanged({ ...zoneState, match_state: 'mismatch' }, zoneState), true);
});

test('hasZoneStateChanged: null and undefined fields are equivalent', () => {
    assert.equal(hasZoneStateChanged(
        { ...zoneState, zone_label: null },
        { ...zoneState, zone_label: undefined }
    ), false);
});

test('displayed location keeps the last stable zone while the watch is temporarily disconnected', () => {
    const startedAt = new Date('2026-09-28T10:00:00Z');
    const displayed = resolveDisplayedLocation(1, null, undefined, {
        board_mac: 'F0:F5:BD:A1:C5:8C',
        zone_label: 'ห้อง 301',
        ward_id: 1,
        match_state: 'expected',
        started_at: startedAt
    });
    assert.deepEqual(displayed, {
        current_zone_label: 'ห้อง 301',
        current_board_mac: 'F0:F5:BD:A1:C5:8C',
        zone_match: 'expected',
        since: startedAt,
        source: 'last_known'
    });
});

test('a newly connected receiver overrides the old last-known zone immediately', () => {
    const displayed = resolveDisplayedLocation(
        2,
        { boardMac: '48:27:E2:B7:89:C4' },
        { wardId: 2, zoneLabel: 'ห้อง 401' },
        {
            board_mac: 'F0:F5:BD:A1:C5:8C',
            zone_label: 'ห้อง 301',
            ward_id: 1,
            match_state: 'mismatch',
            started_at: new Date('2026-09-28T10:00:00Z')
        }
    );
    assert.equal(displayed.current_zone_label, 'ห้อง 401');
    assert.equal(displayed.current_board_mac, '48:27:E2:B7:89:C4');
    assert.equal(displayed.zone_match, 'expected');
    assert.equal(displayed.since, null, 'old zone start time must not leak onto the new receiver');
    assert.equal(displayed.source, 'connected');
});

test('without a current receiver or a stable history row the displayed location is unknown', () => {
    assert.deepEqual(resolveDisplayedLocation(1, null, undefined, null), {
        current_zone_label: null,
        current_board_mac: null,
        zone_match: 'unknown',
        since: null,
        source: 'unknown'
    });
});
