'use strict';

function resolveCurrentZone(nodes, watchMac) {
    if (!Array.isArray(nodes) || !watchMac) return null;
    const target = String(watchMac).trim().toLowerCase();
    for (const node of nodes) {
        if (!node || typeof node !== 'object' || !Array.isArray(node.connectedJstyleMacs)) continue;
        if (node.connectedJstyleMacs.some(mac => String(mac).trim().toLowerCase() === target)) {
            return node;
        }
    }
    return null;
}

// 'unknown' whenever there isn't enough data to make a claim (patient has no
// assigned ward, current node hasn't been labeled with a ward by an admin, or
// the wearable isn't currently connected to any node) — a mismatch must never
// be inferred from missing data.
function zoneMatchState(patientWardId, nodeWardId) {
    if (patientWardId === null || patientWardId === undefined) return 'unknown';
    if (nodeWardId === null || nodeWardId === undefined) return 'unknown';
    return String(patientWardId) === String(nodeWardId) ? 'expected' : 'mismatch';
}

module.exports = { resolveCurrentZone, zoneMatchState };
