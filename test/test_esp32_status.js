'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEsp32Topology } = require('../esp32-status');

test('parses connected ESP32 and JStyle inventory', () => {
    const result = parseEsp32Topology({
        topologyReady: true,
        generatedAtEpoch: 123,
        sensors: {
            'F0:F5:BD:A1:C5:8C': {
                status: 'connected',
                nodeId: 'na1c58c',
                ipAddress: '172.16.251.32',
                boardMac: 'F0:F5:BD:A1:C5:8C',
                connectedJstyleCount: 1,
                lastSeenAgeSeconds: 7,
                watches: [{ watchId: '21:02:02:06:9F:7F', status: 'connected' }]
            }
        }
    }, { sourceAgeSeconds: 2 });

    assert.equal(result.sourceReady, true);
    assert.equal(result.nodes.length, 1);
    assert.deepEqual(result.nodes[0], {
        nodeId: 'na1c58c',
        boardMac: 'F0:F5:BD:A1:C5:8C',
        ipAddress: '172.16.251.32',
        status: 'connected',
        connectedJstyleCount: 1,
        jstyleMacs: ['21:02:02:06:9F:7F'],
        lastSeenAgeSeconds: 7
    });
});

test('stale source never presents nodes as connected', () => {
    const result = parseEsp32Topology({
        topologyReady: true,
        sensors: {
            'F0:F5:BD:A1:C5:8C': {
                status: 'connected',
                nodeId: 'na1c58c',
                ipAddress: '172.16.251.32',
                watches: [{ watchId: '21:02:02:06:9F:7F' }]
            }
        }
    }, { sourceAgeSeconds: 30, sourceStaleSeconds: 15 });

    assert.equal(result.sourceReady, false);
    assert.equal(result.sourceStatus, 'stale');
    assert.equal(result.nodes[0].status, 'unknown');
    assert.equal(result.nodes[0].connectedJstyleCount, 0);
});

test('reconciling topology keeps known identities but marks status unknown', () => {
    const result = parseEsp32Topology({
        topologyReady: false,
        sensors: {
            'F0:F5:BD:A1:C5:8C': {
                status: 'connected',
                nodeId: 'na1c58c',
                ipAddress: '172.16.251.32',
                watches: []
            }
        }
    });

    assert.equal(result.sourceStatus, 'reconciling');
    assert.equal(result.nodes[0].status, 'unknown');
});
