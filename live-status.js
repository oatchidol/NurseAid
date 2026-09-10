'use strict';

function toPositiveNumber(entry) {
    const value = Number(entry?.value);
    return Number.isFinite(value) && value > 0 ? value : null;
}

// Wearable status values as published by the firmware.
//   0 = gone / off wrist, 1 = worn, 2 = still paired but deliberately
//   disconnected for a priority rest (see PRIORITY_* in nurseaid_esp32.ino).
// 2 exists so a battery-saving rest is not indistinguishable from a real
// dropout: the watch is present, it just will not report again until its
// next scheduled measurement.
const WEARABLE_STATUS_OFF_WRIST = 0;
const WEARABLE_STATUS_WORN = 1;
const WEARABLE_STATUS_RESTING = 2;

// How long the node leaves a watch alone between measurements, per priority.
// These MUST track PRIORITY_MEDIUM_INTERVAL_MS / PRIORITY_LOW_INTERVAL_MS in
// the firmware; if they drift apart the server starts calling resting patients
// offline again.
const PRIORITY_REST_SECONDS = { high: 0, medium: 300, low: 600 };

// A measurement cycle plus reconnect backoff takes real time on top of the
// rest itself, so the freshness window has to be the rest interval plus slack.
const PRIORITY_REST_MARGIN_SECONDS = 180;

function priorityRestSeconds(priority) {
    const key = String(priority || 'high').trim().toLowerCase();
    return PRIORITY_REST_SECONDS[key] || 0;
}

// Widen the freshness windows so a patient on medium/low priority is not
// reported stale or offline during a rest the system itself scheduled.
// `high` is returned untouched, so a fleet that never sets priority behaves
// exactly as it did before this existed.
function freshnessPolicyForPriority(basePolicy, priority) {
    const restSeconds = priorityRestSeconds(priority);
    // Always hand back a fresh object, never the caller's own policy: the
    // global LIVE_FRESHNESS_POLICY is shared by every device on every poll,
    // and one careless mutation downstream would silently retune the whole
    // ward's staleness rules.
    if (!restSeconds) return { ...basePolicy };
    const floor = restSeconds + PRIORITY_REST_MARGIN_SECONDS;
    const widen = value => Math.max(Number(value) || 0, floor);
    return {
        ...basePolicy,
        clinical: widen(basePolicy?.clinical),
        status: widen(basePolicy?.status),
        quality: widen(basePolicy?.quality),
        presence: widen(basePolicy?.presence)
        // battery and liveHr are deliberately left alone: battery is already
        // far longer than any rest, and hrLive means "streaming right now",
        // which a resting watch genuinely is not.
    };
}

// The offline alert must not fire inside a scheduled rest either. Raise the
// operator's configured threshold to the rest window when priority demands it,
// never lower it.
function offlineThresholdMinutesForPriority(settings, priority) {
    const configured = offlineThresholdMinutes(settings);
    const restSeconds = priorityRestSeconds(priority);
    if (!restSeconds) return configured;
    const floorMinutes = Math.ceil((restSeconds + PRIORITY_REST_MARGIN_SECONDS) / 60);
    return Math.min(60, Math.max(configured, floorMinutes));
}

function calculateQueryWindowMinutes(freshnessSeconds, minimumMinutes = 5) {
    const values = Object.values(freshnessSeconds || {})
        .map(Number)
        .filter(value => Number.isFinite(value) && value > 0);
    const longestSeconds = values.length ? Math.max(...values) : 0;
    return Math.max(minimumMinutes, Math.ceil(longestSeconds / 60) + 1);
}

function offlineThresholdMinutes(settings = {}, fallbackMinutes = 2) {
    const configured = Number(settings.offline_threshold_minutes);
    const fallback = Number(fallbackMinutes);
    const minutes = Number.isFinite(configured) ? configured : (Number.isFinite(fallback) ? fallback : 2);
    return Math.min(60, Math.max(1, Math.round(minutes)));
}

function shouldRaiseOfflineAlert(status, settings = {}, uptimeSeconds = Infinity) {
    if (!status || status.telemetryStale || status.status === 'Unavailable' || status.status === 'Recovering') {
        return false;
    }

    const thresholdSeconds = offlineThresholdMinutes(settings) * 60;
    const hasLastSeen = status.lastSeenSeconds !== null
        && status.lastSeenSeconds !== undefined
        && status.lastSeenSeconds !== '';
    const lastSeenSeconds = Number(status.lastSeenSeconds);
    if (hasLastSeen && Number.isFinite(lastSeenSeconds) && lastSeenSeconds >= 0) {
        return lastSeenSeconds >= thresholdSeconds;
    }

    // A newly paired device that has never produced telemetry must be given the
    // same grace period after application startup before it is called offline.
    return status.status === 'Offline' && Number(uptimeSeconds) >= thresholdSeconds;
}

function buildLiveSnapshot(sensor, nowMs, freshness) {
    const legacySeconds = Number(freshness);
    const policy = Number.isFinite(legacySeconds)
        ? {
            clinical: legacySeconds, status: legacySeconds, battery: legacySeconds,
            quality: legacySeconds, presence: legacySeconds, liveHr: legacySeconds
        }
        : {
            clinical: Number(freshness?.clinical) || 600,
            status: Number(freshness?.status) || 180,
            battery: Number(freshness?.battery) || 1800,
            quality: Number(freshness?.quality) || 600,
            presence: Number(freshness?.presence) || 90,
            liveHr: Number(freshness?.liveHr) || 30
        };
    const freshnessFor = key => {
        if (['heart', 'spo2', 'temp'].includes(key)) return policy.clinical;
        if (key === 'battery') return policy.battery;
        if (key === 'spo2Quality') return policy.quality;
        if (key === 'rssi') return policy.presence;
        return policy.status;
    };
    const fresh = key => {
        const entry = sensor?.[key];
        return entry && Number.isFinite(entry.timestampMs) && nowMs - entry.timestampMs <= freshnessFor(key) * 1000
            ? entry
            : null;
    };
    const current = fresh;

    const freshEntries = ['heart', 'spo2', 'temp', 'status', 'battery', 'spo2Quality', 'rssi']
        .map(fresh)
        .filter(Boolean);
    const vitalEntries = ['heart', 'spo2', 'temp'].map(current).filter(Boolean);
    const connectivityEntries = ['heart', 'spo2', 'temp', 'status', 'spo2Quality', 'rssi']
        .map(fresh)
        .filter(Boolean);
    const statusEntry = current('status');
    const statusValue = statusEntry ? Number(statusEntry.value) : null;
    const connected = connectivityEntries.length > 0;
    const recoveryPending = false;
    // A resting watch is still on the patient - it simply is not measuring, so
    // it must read as worn or the dashboard would blank out mid-rest.
    const worn = statusValue === WEARABLE_STATUS_WORN
        || statusValue === WEARABLE_STATUS_RESTING
        || (statusValue === null && vitalEntries.some(entry => toPositiveNumber(entry) !== null));
    const explicitOffWrist = statusValue === WEARABLE_STATUS_OFF_WRIST;
    const ageSeconds = key => {
        const timestampMs = sensor?.[key]?.timestampMs;
        return Number.isFinite(timestampMs) ? Math.max(0, Math.floor((nowMs - timestampMs) / 1000)) : null;
    };
    const heartAgeSeconds = ageSeconds('heart');
    const value = (key, integer = false) => {
        const number = toPositiveNumber(current(key));
        if (number === null) return '--';
        return integer ? Math.round(number) : number;
    };
    const timestamps = freshEntries.map(entry => entry.timestampMs);
    const vitalTimestamps = vitalEntries.map(entry => entry.timestampMs);

    return {
        connected,
        recoveryPending,
        worn,
        explicitOffWrist,
        hr: value('heart', true),
        spo2: value('spo2', true),
        temp: value('temp'),
        battery: (() => {
            const number = Number(fresh('battery')?.value);
            return Number.isFinite(number) ? Math.round(number) : '--';
        })(),
        rssi: (() => {
            const number = Number(fresh('rssi')?.value);
            return Number.isFinite(number) ? Math.round(number) : null;
        })(),
        presence: current('rssi') ? 'present' : 'unknown',
        hrLive: heartAgeSeconds !== null && heartAgeSeconds <= policy.liveHr,
        metricAges: {
            hr: heartAgeSeconds,
            spo2: ageSeconds('spo2'),
            temp: ageSeconds('temp'),
            status: ageSeconds('status'),
            battery: ageSeconds('battery'),
            presence: ageSeconds('rssi')
        },
        spo2Quality: current('spo2Quality')?.value,
        activity: (() => {
            const entry = sensor?.activity;
            return entry && Number.isFinite(entry.timestampMs) && nowMs - entry.timestampMs <= policy.status * 1000
                ? entry.value
                : null;
        })(),
        sensorHealth: (() => {
            const activityEntry = sensor?.activity;
            const activityValue = activityEntry && Number.isFinite(activityEntry.timestampMs)
                && nowMs - activityEntry.timestampMs <= policy.status * 1000
                ? activityEntry.value : null;
            if (activityValue === 'sensor_failure') return 'failure';
            if (!connected && !vitalEntries.length) return 'unknown';
            if (vitalEntries.length > 0) return 'healthy';
            if (connected) return 'weak';
            return 'unknown';
        })(),
        lastUpdatedAgo: (() => {
            const allTs = vitalTimestamps.length ? Math.max(...vitalTimestamps) : null;
            if (!allTs) return null;
            return Math.max(0, Math.floor((nowMs - allTs) / 1000));
        })(),
        lastSeenMs: timestamps.length ? Math.max(...timestamps) : null,
        vitalLastSeenMs: vitalTimestamps.length ? Math.max(...vitalTimestamps) : null
    };
}

function createSingleFlightCache(loader, ttlMs) {
    let value;
    let loadedAt = 0;
    let inFlight = null;

    return async function read(options = {}) {
        const now = Date.now();
        if (!options.force && value !== undefined && now - loadedAt < ttlMs) return value;
        if (inFlight) return inFlight;

        inFlight = Promise.resolve()
            .then(loader)
            .then(result => {
                value = result;
                loadedAt = Date.now();
                return result;
            })
            .finally(() => { inFlight = null; });
        return inFlight;
    };
}

function createResilientSingleFlightCache(loader, ttlMs, maxStaleMs) {
    let value;
    let loadedAt = 0;
    let inFlight = null;

    return async function read(options = {}) {
        const now = Date.now();
        if (!options.force && value !== undefined && now - loadedAt < ttlMs) {
            return { value, stale: false, ageMs: now - loadedAt, error: null };
        }
        if (inFlight) return inFlight;

        inFlight = Promise.resolve()
            .then(loader)
            .then(result => {
                value = result;
                loadedAt = Date.now();
                return { value: result, stale: false, ageMs: 0, error: null };
            })
            .catch(error => {
                const ageMs = loadedAt ? Date.now() - loadedAt : Infinity;
                if (value === undefined || ageMs > maxStaleMs) throw error;
                return { value, stale: true, ageMs, error };
            })
            .finally(() => { inFlight = null; });
        return inFlight;
    };
}

function markStatusesUnavailable(statuses, reason = 'telemetry_unavailable') {
    const nowMs = Date.now();
    return (statuses || []).map(status => {
        const lastSeenMs = Date.parse(status.lastSeenAt || '');
        return {
            ...status,
            hr: '--',
            spo2: '--',
            temp: '--',
            status: 'Unavailable',
            isWorn: null,
            alertLevel: 'normal',
            alertCauses: [],
            dataQuality: reason,
            dataMessage: 'แหล่งข้อมูลสัญญาณชีพขัดข้อง · ระบบกำลังเชื่อมต่อใหม่',
            diagnosticCode: reason,
            missingMetrics: ['HR', 'SpO2', 'Temp'],
            lastKnownAgeSeconds: Number.isFinite(lastSeenMs)
                ? Math.max(0, Math.floor((nowMs - lastSeenMs) / 1000))
                : null,
            telemetryStale: true
        };
    });
}

module.exports = {
    WEARABLE_STATUS_OFF_WRIST,
    WEARABLE_STATUS_WORN,
    WEARABLE_STATUS_RESTING,
    PRIORITY_REST_SECONDS,
    priorityRestSeconds,
    freshnessPolicyForPriority,
    offlineThresholdMinutesForPriority,
    calculateQueryWindowMinutes,
    buildLiveSnapshot,
    createSingleFlightCache,
    createResilientSingleFlightCache,
    markStatusesUnavailable,
    offlineThresholdMinutes,
    shouldRaiseOfflineAlert
};
