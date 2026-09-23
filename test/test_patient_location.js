'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEsp32Topology } = require('../esp32-status');
const { resolveCurrentZone, zoneMatchState } = require('../patient-location');

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
