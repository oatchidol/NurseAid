'use strict';

function toPositiveNumber(entry) {
    const value = Number(entry?.value);
    return Number.isFinite(value) && value > 0 ? value : null;
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

    const freshEntries = ['heart', 'spo2', 'temp', 'status', 'battery', 'spo2Quality', 'rssi']
        .map(fresh)
        .filter(Boolean);
    const vitalEntries = ['heart', 'spo2', 'temp'].map(fresh).filter(Boolean);
    const connectivityEntries = ['heart', 'spo2', 'temp', 'status', 'spo2Quality', 'rssi']
        .map(fresh)
        .filter(Boolean);
    const statusEntry = fresh('status');
    const statusValue = statusEntry ? Number(statusEntry.value) : null;
    const connected = connectivityEntries.length > 0;
    const worn = statusValue === 1 || (statusValue === null && vitalEntries.some(entry => toPositiveNumber(entry) !== null));
    const explicitOffWrist = statusValue === 0;
    const ageSeconds = key => {
        const timestampMs = sensor?.[key]?.timestampMs;
        return Number.isFinite(timestampMs) ? Math.max(0, Math.floor((nowMs - timestampMs) / 1000)) : null;
    };
    const heartAgeSeconds = ageSeconds('heart');
    const value = (key, integer = false) => {
        const number = toPositiveNumber(fresh(key));
        if (number === null) return '--';
        return integer ? Math.round(number) : number;
    };
    const timestamps = freshEntries.map(entry => entry.timestampMs);
    const vitalTimestamps = vitalEntries.map(entry => entry.timestampMs);

    return {
        connected,
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
        presence: fresh('rssi') ? 'present' : 'unknown',
        hrLive: heartAgeSeconds !== null && heartAgeSeconds <= policy.liveHr,
        metricAges: {
            hr: heartAgeSeconds,
            spo2: ageSeconds('spo2'),
            temp: ageSeconds('temp'),
            status: ageSeconds('status'),
            battery: ageSeconds('battery'),
            presence: ageSeconds('rssi')
        },
        spo2Quality: fresh('spo2Quality')?.value,
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
    return (statuses || []).map(status => ({
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
        telemetryStale: true
    }));
}

module.exports = {
    buildLiveSnapshot,
    createSingleFlightCache,
    createResilientSingleFlightCache,
    markStatusesUnavailable
};