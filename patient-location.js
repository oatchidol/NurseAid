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

// Decides whether a new patient_zone_history interval should be opened for the
// current tick. `openRow` is the currently-open history row for this mac (shape
// { board_mac, zone_label, ward_id, match_state }), or null/undefined when no
// interval is open yet. `current` is the freshly computed state this tick, same
// shape. Returns true when the state differs from the open row (so a new
// interval opens), false when nothing changed. With no open row we always open.
//
// Each field is compared loosely: null/undefined count as equal to each other
// but never to a real value, and a numeric ward_id equals its string form
// (pg returns INTEGER as a JS number — the same String() coercion zoneMatchState
// relies on). This keeps a numeric-vs-string ward_id from being a false change.
function hasZoneStateChanged(openRow, current) {
    if (!openRow) return true;
    const fields = ['board_mac', 'zone_label', 'ward_id', 'match_state'];
    for (const field of fields) {
        const openVal = openRow[field];
        const curVal = current[field];
        if (String(openVal ?? '') !== String(curVal ?? '')) return true;
    }
    return false;
}

// The dashboard should not flicker to "unknown" while a medium/low-priority
// wearable is intentionally disconnected between measurement rounds. The open
// history row is the last stable receiver assignment; use it only when there is
// no current receiver. A real current receiver always wins immediately.
function resolveDisplayedLocation(patientWardId, currentNode, nodeZone, openRow) {
    if (currentNode) {
        const boardMac = currentNode.boardMac || null;
        const sameOpenBoard = openRow
            && String(openRow.board_mac || '').toUpperCase() === String(boardMac || '').toUpperCase();
        return {
            current_zone_label: nodeZone?.zoneLabel || null,
            current_board_mac: boardMac,
            zone_match: zoneMatchState(patientWardId, nodeZone?.wardId),
            since: sameOpenBoard ? (openRow.started_at || null) : null,
            source: 'connected'
        };
    }

    if (openRow && openRow.board_mac) {
        return {
            current_zone_label: openRow.zone_label || null,
            current_board_mac: openRow.board_mac,
            zone_match: zoneMatchState(patientWardId, openRow.ward_id),
            since: openRow.started_at || null,
            source: 'last_known'
        };
    }

    return {
        current_zone_label: null,
        current_board_mac: null,
        zone_match: 'unknown',
        since: null,
        source: 'unknown'
    };
}

module.exports = { resolveCurrentZone, zoneMatchState, hasZoneStateChanged, resolveDisplayedLocation };
