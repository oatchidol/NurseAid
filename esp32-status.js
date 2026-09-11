'use strict';

const fs = require('fs');

const MAC_RE = /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const NODE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VALID_STATUS = new Set(['connected', 'disconnected', 'unknown']);

function canonicalMac(value) {
    const text = String(value || '').trim().replace(/-/g, ':').toUpperCase();
    return MAC_RE.test(text) ? text : '';
}

function safeAge(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 86400 * 30) return null;
    return Math.round(number);
}

function parseEsp32Topology(value, { sourceAgeSeconds = 0, sourceStaleSeconds = 15 } = {}) {
    const sourceAge = Math.max(0, Number(sourceAgeSeconds) || 0);
    const sourceStale = sourceAge > Math.max(1, Number(sourceStaleSeconds) || 15);
    const ready = Boolean(value && typeof value === 'object' && value.topologyReady === true);
    const rawSensors = value && typeof value === 'object' && value.sensors && typeof value.sensors === 'object'
        ? value.sensors
        : {};

    const nodes = [];
    for (const [rawKey, rawNode] of Object.entries(rawSensors)) {
        if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) continue;
        const boardMac = canonicalMac(rawNode.boardMac || rawKey);
        const nodeId = String(rawNode.nodeId || '').trim();
        const ipAddress = String(rawNode.ipAddress || '').trim();
        if (!boardMac || !NODE_RE.test(nodeId) || !ipAddress || ipAddress.length > 64) continue;

        const watches = Array.isArray(rawNode.watches) ? rawNode.watches : [];
        // The collector stamps every watch with 'connected' | 'disconnected' |
        // 'unknown' (and forces 'unknown' when its own snapshot is stale), so the
        // per-watch liveness signal is always present. Keep both views of it:
        // jstyleMacs is the full roster this node knows about -- the patient
        // lookup and the unclaimed-hardware hint both need every MAC -- while
        // liveJstyleMacs is the subset anything user-facing may call connected.
        // Only an explicit 'connected' counts: we never assert a radio link we
        // have no positive evidence for.
        const jstyleMacs = [];
        const claimedLive = new Set();
        const seenDropped = new Set();
        for (const rawWatch of watches) {
            if (!rawWatch || typeof rawWatch !== 'object') continue;
            const watchMac = canonicalMac(rawWatch.watchId);
            if (!watchMac) continue;
            if (!jstyleMacs.includes(watchMac)) jstyleMacs.push(watchMac);
            if (rawWatch.status === 'connected') claimedLive.add(watchMac);
            else seenDropped.add(watchMac);
        }
        // A node can list the same watch twice with conflicting status -- the collector
        // appends every entry it is handed and never dedupes -- so resolve the conflict
        // rather than letting arrival order decide it. Evidence of a drop outweighs a
        // claim of a link in both directions: asserting a link that is already gone is
        // precisely the failure this field exists to prevent.
        for (const mac of seenDropped) claimedLive.delete(mac);

        const rawStatus = VALID_STATUS.has(rawNode.status) ? rawNode.status : 'unknown';
        const status = sourceStale || !ready ? 'unknown' : rawStatus;
        // A receiver that is down or unproven cannot be holding anything, whatever
        // its last snapshot claimed about individual watches. filter() rather than
        // spreading the Set so the order matches jstyleMacs.
        const connectedJstyleMacs = status === 'connected'
            ? jstyleMacs.filter(mac => claimedLive.has(mac))
            : [];
        // One source of truth. The board also self-reports a connectedJstyleCount, but
        // the collector already rejects any snapshot where that disagrees with the
        // connected watch entries, and deriving the count here means it can never
        // contradict the list rendered next to it.
        const connectedJstyleCount = connectedJstyleMacs.length;

        nodes.push({
            nodeId,
            boardMac,
            ipAddress,
            status,
            connectedJstyleCount,
            jstyleMacs,
            connectedJstyleMacs,
            lastSeenAgeSeconds: safeAge(rawNode.lastSeenAgeSeconds)
        });
    }

    nodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.boardMac.localeCompare(b.boardMac));
    return {
        sourceReady: ready && !sourceStale,
        sourceStatus: sourceStale ? 'stale' : (ready ? 'ready' : 'reconciling'),
        sourceAgeSeconds: Math.round(sourceAge),
        generatedAtEpoch: Number.isFinite(Number(value && value.generatedAtEpoch)) ? Number(value.generatedAtEpoch) : null,
        nodes
    };
}

function readMqttClientIps(filePath) {
    try {
        const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const raw = Array.isArray(value && value.mqttClientIps) ? value.mqttClientIps : [];
        return new Set(raw.map(item => String(item || '').trim()).filter(Boolean));
    } catch (_error) {
        return new Set();
    }
}

function readEsp32Topology(filePath, options = {}) {
    try {
        const stat = fs.statSync(filePath);
        const sourceAgeSeconds = Math.max(0, (Date.now() - stat.mtimeMs) / 1000);
        const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return parseEsp32Topology(value, { ...options, sourceAgeSeconds });
    } catch (error) {
        return {
            sourceReady: false,
            sourceStatus: 'unavailable',
            sourceAgeSeconds: null,
            generatedAtEpoch: null,
            nodes: [],
            error: error && error.code ? error.code : 'invalid_snapshot'
        };
    }
}

/**
 * Compute receiver-board availability over a sliding time window from ordered
 * online/offline transition events. Pure function — no DB, no side effects.
 *
 * The board is treated as offline only during spans that begin with an 'offline'
 * event and end at the next 'online' event (or at `nowMs` if still offline).
 * Events older than the window are consulted to determine the state AT the
 * window start; without such an event we fall back to `currentlyOnline`.
 */
function summariseEsp32Uptime(events, windowMs, nowMs, currentlyOnline) {
    const defaultResult = { uptimePercent: 100, offlineSeconds: 0, outageCount: 0 };

    // Guard against garbage input — return a safe default rather than throwing.
    if (!Array.isArray(events) || !Number.isFinite(Number(windowMs)) || !Number.isFinite(Number(nowMs))) {
        return defaultResult;
    }

    const windowStart = nowMs - Number(windowMs);

    // Filter to valid liveness transitions and sort ascending by time.
    const validEvents = [];
    for (const e of events) {
        if (!e || typeof e !== 'object') continue;
        if (e.event_type !== 'online' && e.event_type !== 'offline') continue;
        const t = new Date(e.created_at).getTime();
        if (!Number.isFinite(t)) continue;
        validEvents.push({ event_type: e.event_type, created_at: t });
    }
    validEvents.sort((a, b) => a.created_at - b.created_at);

    // Determine the board's state at the exact window start.
    // Events before the window set the initial state; without one we assume
    // `currentlyOnline` (the caller's best guess from heartbeat freshness).
    let initialState = currentlyOnline;
    let hadPreWindowEvent = false;
    for (let i = validEvents.length - 1; i >= 0; i--) {
        if (validEvents[i].created_at < windowStart) {
            initialState = validEvents[i].event_type === 'online';
            hadPreWindowEvent = true;
            break;
        }
    }

    // Walk the window, accumulating offline seconds and counting outages.
    let isOffline = !initialState;
    let offlineSeconds = 0;
    let outageCount = 0;
    let lastTime = windowStart;

    // If the board was already offline when the window started (due to an actual
    // pre-window offline event), count that ongoing outage — otherwise a board
    // dead for days would report "outages 0" on a 24h dashboard. We only do this
    // when a real pre-window event exists; the empty-events + currentlyOnline=false
    // fallback is intentional and must remain outageCount 0.
    if (isOffline && hadPreWindowEvent) {
        outageCount++;
    }

    for (const event of validEvents) {
        if (event.created_at > nowMs) continue;   // skip future events
        if (event.created_at < windowStart) continue; // already folded into initialState

        // The segment [lastTime, event.created_at] carries the current state.
        if (isOffline) {
            offlineSeconds += (event.created_at - lastTime) / 1000;
        }

        if (event.event_type === 'offline') {
            if (!isOffline) outageCount++; // new outage begins
            isOffline = true;
        } else {
            // event_type === 'online' — outage ends if we were in one
            isOffline = false;
        }
        lastTime = event.created_at;
    }

    // Final segment from the last event (or window start) through nowMs.
    if (isOffline) {
        offlineSeconds += (nowMs - lastTime) / 1000;
    }

    const totalSeconds = Number(windowMs) / 1000;
    const uptimePercent = totalSeconds > 0
        ? Math.round(((totalSeconds - offlineSeconds) / totalSeconds) * 1000) / 10
        : 100;

    return {
        uptimePercent: Math.max(0, Math.min(100, uptimePercent)),
        offlineSeconds: Math.round(offlineSeconds),
        outageCount
    };
}

/**
 * Count reboot events for a single board over a sliding time window, and
 * surface the most recent boot reason / timestamp. Pure function — no DB,
 * no side effects.
 *
 * `detail` may arrive as a JS object (node-postgres JSONB parser) or as a
 * JSON string (some drivers / mock layers stringify it). We normalise both
 * without throwing so the UI never breaks on a malformed row.
 *
 * `created_at` may be a Date or an ISO string — we coerce numerically via
 * `new Date(...).getTime()` and compare numbers, never with bare `.sort()`
 * or string subtraction (that exact bug was already fixed elsewhere in this
 * codebase).
 */
function summariseEsp32Reboots(events, windowMs, nowMs) {
    const defaultResult = { rebootCount: 0, lastReason: null, lastRebootAt: null };

    // Guard against garbage input — return a safe default rather than throwing.
    if (!Array.isArray(events) || !Number.isFinite(Number(windowMs)) || !Number.isFinite(Number(nowMs))) {
        return defaultResult;
    }

    const windowStart = nowMs - Number(windowMs);

    // Collect reboot events whose created_at falls inside the window, coercing
    // timestamps numerically so Date objects and ISO strings are treated alike.
    const reboots = [];
    for (const e of events) {
        if (!e || typeof e !== 'object') continue;
        if (e.event_type !== 'reboot') continue;
        const t = new Date(e.created_at).getTime();
        if (!Number.isFinite(t)) continue;
        if (t < windowStart || t > nowMs) continue;

        // Normalise detail: node-postgres returns a JS object for JSONB, but
        // some test doubles / mock layers stringify it first. Handle both.
        let detail = null;
        try {
            if (e.detail && typeof e.detail === 'object') {
                detail = e.detail;
            } else if (typeof e.detail === 'string') {
                detail = JSON.parse(e.detail);
            }
        } catch (_parseErr) {
            // Garbage JSON — leave detail as null; we still count the reboot.
        }

        reboots.push({ created_at: t, reason: detail && typeof detail.reason === 'string' ? detail.reason : null });
    }

    if (!reboots.length) {
        return defaultResult;
    }

    // Sort ascending by numeric time — never use bare .sort() on Dates.
    reboots.sort((a, b) => a.created_at - b.created_at);

    const last = reboots[reboots.length - 1];
    return {
        rebootCount: reboots.length,
        lastReason: last.reason || null,
        lastRebootAt: new Date(last.created_at).toISOString()
    };
}

module.exports = {
    canonicalMac,
    parseEsp32Topology,
    readEsp32Topology,
    readMqttClientIps,
    summariseEsp32Uptime,
    summariseEsp32Reboots
};
