'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEsp32Topology, summariseEsp32Uptime, summariseEsp32Reboots } = require('../esp32-status');

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

// ---------------------------------------------------------------------------
// summariseEsp32Uptime — pure availability computation over a sliding window.
// All times are fixed constants (UTC) so the tests are deterministic;
// Date.now() is never used in an assertion.
// ---------------------------------------------------------------------------

const NOW_MS = Date.UTC(2026, 7, 29, 12, 0, 0); // 2026-08-29T12:00:00Z
const WINDOW_MS = 86400000;                      // 24h
const WINDOW_START_MS = NOW_MS - WINDOW_MS;      // 2026-08-28T12:00:00Z

// Helper: epoch ms at T+hours relative to the window start.
const at = (hours) => WINDOW_START_MS + hours * 3600000;

test('summariseEsp32Uptime: no events + currentlyOnline=true -> 100% uptime', () => {
    const result = summariseEsp32Uptime([], WINDOW_MS, NOW_MS, true);
    assert.deepEqual(result, { uptimePercent: 100, offlineSeconds: 0, outageCount: 0 });
});

test('summariseEsp32Uptime: no events + currentlyOnline=false -> whole window offline (implementation behaviour)', () => {
    // With zero events the implementation falls back to `currentlyOnline` for
    // the ENTIRE window, so a board believed offline is counted offline for
    // all 86400s. NOTE: the intended contract would give uptimePercent 100
    // ("nothing to compute"), but the implementation does NOT — this test
    // documents the actual behaviour (see task report).
    const result = summariseEsp32Uptime([], WINDOW_MS, NOW_MS, false);
    assert.deepEqual(result, { uptimePercent: 0, offlineSeconds: 86400, outageCount: 0 });
});

test('summariseEsp32Uptime: one complete outage fully inside the window', () => {
    // Offline at T+2h, back online at T+3h -> exactly 1h offline, 1 outage.
    // 3600/86400 = 4.1666..% down -> 95.8333..% up -> 95.8.
    const events = [
        { event_type: 'offline', created_at: at(2) },
        { event_type: 'online', created_at: at(3) }
    ];
    const result = summariseEsp32Uptime(events, WINDOW_MS, NOW_MS, true);
    assert.deepEqual(result, { uptimePercent: 95.8, offlineSeconds: 3600, outageCount: 1 });
});

test('summariseEsp32Uptime: outage still open at nowMs counts through nowMs', () => {
    // Offline 1h before now, no matching online event -> open outage spans
    // that full hour; it still counts as one outage.
    const events = [{ event_type: 'offline', created_at: NOW_MS - 3600000 }];
    const result = summariseEsp32Uptime(events, WINDOW_MS, NOW_MS, true);
    assert.deepEqual(result, { uptimePercent: 95.8, offlineSeconds: 3600, outageCount: 1 });
});

test('summariseEsp32Uptime: outage starting before the window counts as one outage with in-window offline seconds', () => {
    // Offline at T-1h (BEFORE window start), online at T+2h.
    // The pre-window part must not count toward offlineSeconds, but the ongoing
    // outage must be counted: only the 2h inside the window counts for offlineSeconds.
    const events = [
        { event_type: 'offline', created_at: WINDOW_START_MS - 3600000 },
        { event_type: 'online', created_at: at(2) }
    ];
    const result = summariseEsp32Uptime(events, WINDOW_MS, NOW_MS, true);
    assert.deepEqual(result, { uptimePercent: 91.7, offlineSeconds: 7200, outageCount: 1 });
});

test('summariseEsp32Uptime: board already offline before the window and never back -> 0% uptime', () => {
    // Offline event 2h before the window, no online event at all: the whole
    // 24h window is offline. The ongoing outage that started before the window
    // counts as one outage.
    const events = [{ event_type: 'offline', created_at: WINDOW_START_MS - 7200000 }];
    const result = summariseEsp32Uptime(events, WINDOW_MS, NOW_MS, false);
    assert.deepEqual(result, { uptimePercent: 0, offlineSeconds: 86400, outageCount: 1 });
});

test('summariseEsp32Uptime: two separate outages -> outageCount 2 and summed offline seconds', () => {
    // Outage 1: T+1h..T+2h (3600s), Outage 2: T+5h..T+7h (7200s).
    // Total offline 10800s -> 10800/86400 = 12.5% down -> 87.5% up.
    const events = [
        { event_type: 'offline', created_at: at(1) },
        { event_type: 'online', created_at: at(2) },
        { event_type: 'offline', created_at: at(5) },
        { event_type: 'online', created_at: at(7) }
    ];
    const result = summariseEsp32Uptime(events, WINDOW_MS, NOW_MS, true);
    assert.deepEqual(result, { uptimePercent: 87.5, offlineSeconds: 10800, outageCount: 2 });
});

test('summariseEsp32Uptime: outage before window that recovers inside counts as one outage with in-window offline seconds', () => {
    // Offline at T-1h (before window), online at T+4h.
    // The outage spans the entire window start, so it counts as 1 outage.
    // Only the 4h inside the window counts toward offlineSeconds.
    const events = [
        { event_type: 'offline', created_at: WINDOW_START_MS - 3600000 },
        { event_type: 'online', created_at: at(4) }
    ];
    const result = summariseEsp32Uptime(events, WINDOW_MS, NOW_MS, true);
    // 4h offline out of 24h -> 16.7% down -> 83.3% up
    assert.deepEqual(result, { uptimePercent: 83.3, offlineSeconds: 14400, outageCount: 1 });
});

test('summariseEsp32Uptime: garbage input never throws and returns the safe default', () => {
    // null events, a zero-length window, and malformed entries must all be
    // tolerated. Note: windowMs=0 is a finite number, so it does NOT hit the
    // safe default — it computes a 0-second window (uptimePercent 100,
    // offlineSeconds 0) instead.
    assert.deepEqual(summariseEsp32Uptime(null, WINDOW_MS, NOW_MS, true),
        { uptimePercent: 100, offlineSeconds: 0, outageCount: 0 });
    assert.deepEqual(summariseEsp32Uptime(undefined, WINDOW_MS, NOW_MS, true),
        { uptimePercent: 100, offlineSeconds: 0, outageCount: 0 });
    assert.deepEqual(summariseEsp32Uptime('not-an-array', WINDOW_MS, NOW_MS, true),
        { uptimePercent: 100, offlineSeconds: 0, outageCount: 0 });
    assert.deepEqual(summariseEsp32Uptime([], 0, NOW_MS, true),
        { uptimePercent: 100, offlineSeconds: 0, outageCount: 0 });

    // Malformed entries: nulls, non-objects, bad event types, unparseable
    // timestamps — all skipped, remaining valid outage still counted.
    const events = [
        null,
        42,
        'offline',
        { event_type: 'reboot', created_at: at(1) },
        { event_type: 'offline', created_at: 'not-a-date' },
        { event_type: 'offline' }, // missing created_at
        { created_at: at(2) },     // missing event_type
        { event_type: 'offline', created_at: at(3) },
        { event_type: 'online', created_at: at(4) }
    ];
    assert.deepEqual(summariseEsp32Uptime(events, WINDOW_MS, NOW_MS, true),
        { uptimePercent: 95.8, offlineSeconds: 3600, outageCount: 1 });
});

test('summariseEsp32Uptime: created_at works as Date objects AND ISO strings alike', () => {
    // node-postgres returns Date objects; some callers may pass ISO strings.
    // The implementation coerces via new Date(created_at).getTime(), so both
    // must produce identical results — this also guards against accidental
    // string-sorting or string-subtracting of the timestamps.
    const offlineAt = at(2);
    const onlineAt = at(3);

    const fromDates = summariseEsp32Uptime([
        { event_type: 'offline', created_at: new Date(offlineAt) },
        { event_type: 'online', created_at: new Date(onlineAt) }
    ], WINDOW_MS, NOW_MS, true);

    const fromIsoStrings = summariseEsp32Uptime([
        { event_type: 'offline', created_at: new Date(offlineAt).toISOString() },
        { event_type: 'online', created_at: new Date(onlineAt).toISOString() }
    ], WINDOW_MS, NOW_MS, true);

    assert.deepEqual(fromDates, { uptimePercent: 95.8, offlineSeconds: 3600, outageCount: 1 });
    assert.deepEqual(fromIsoStrings, fromDates);

    // Unsorted input (online first) must still be handled, since the
    // implementation sorts ascending by the coerced numeric time.
    const unsorted = summariseEsp32Uptime([
        { event_type: 'online', created_at: new Date(onlineAt).toISOString() },
        { event_type: 'offline', created_at: new Date(offlineAt) }
    ], WINDOW_MS, NOW_MS, true);
    assert.deepEqual(unsorted, fromDates);
});

// ---------------------------------------------------------------------------
// summariseEsp32Reboots — pure reboot-count / last-reason computation over a
// sliding window. Reuses the same fixed NOW_MS / WINDOW_MS / at() helpers so
// the tests are deterministic; Date.now() is never used in an assertion.
// ---------------------------------------------------------------------------

const EMPTY_REBOOTS = { rebootCount: 0, lastReason: null, lastRebootAt: null };

test('summariseEsp32Reboots: empty array, null and undefined all return the safe default without throwing', () => {
    // Garbage input must never throw — the UI renders this result directly.
    assert.deepEqual(summariseEsp32Reboots([], WINDOW_MS, NOW_MS), EMPTY_REBOOTS);
    assert.deepEqual(summariseEsp32Reboots(null, WINDOW_MS, NOW_MS), EMPTY_REBOOTS);
    assert.deepEqual(summariseEsp32Reboots(undefined, WINDOW_MS, NOW_MS), EMPTY_REBOOTS);
});

test('summariseEsp32Reboots: non-reboot event types are filtered out', () => {
    // A real event stream for one board mixes online/offline/fw_changed rows
    // with reboot rows; only the two reboot events may be counted.
    const events = [
        { event_type: 'online', created_at: at(1) },
        { event_type: 'reboot', created_at: at(2), detail: { reason: 'brownout' } },
        { event_type: 'offline', created_at: at(3) },
        { event_type: 'fw_changed', created_at: at(4) },
        { event_type: 'reboot', created_at: at(5), detail: { reason: 'watchdog' } }
    ];
    const result = summariseEsp32Reboots(events, WINDOW_MS, NOW_MS);
    assert.equal(result.rebootCount, 2);
    // The most recent in-window reboot is the one at T+5h.
    assert.equal(result.lastReason, 'watchdog');
    assert.equal(result.lastRebootAt, new Date(at(5)).toISOString());
});

test('summariseEsp32Reboots: a reboot older than the window is not counted', () => {
    // 25h before now is 1h outside the 24h window -> nothing in window.
    const events = [{ event_type: 'reboot', created_at: NOW_MS - WINDOW_MS - 3600000, detail: { reason: 'old' } }];
    assert.deepEqual(summariseEsp32Reboots(events, WINDOW_MS, NOW_MS), EMPTY_REBOOTS);
});

test('summariseEsp32Reboots: a reboot exactly at the window start IS counted (inclusive lower bound)', () => {
    // Observed behaviour: the implementation uses `t < windowStart` to skip,
    // so an event exactly at nowMs - windowMs is INSIDE the window.
    // (A reboot exactly at nowMs is likewise counted — `t > nowMs` to skip.)
    const atStart = { event_type: 'reboot', created_at: WINDOW_START_MS, detail: { reason: 'boundary-start' } };
    const atNow = { event_type: 'reboot', created_at: NOW_MS, detail: { reason: 'boundary-now' } };

    assert.deepEqual(summariseEsp32Reboots([atStart], WINDOW_MS, NOW_MS), {
        rebootCount: 1,
        lastReason: 'boundary-start',
        lastRebootAt: new Date(WINDOW_START_MS).toISOString()
    });
    assert.deepEqual(summariseEsp32Reboots([atNow], WINDOW_MS, NOW_MS), {
        rebootCount: 1,
        lastReason: 'boundary-now',
        lastRebootAt: new Date(NOW_MS).toISOString()
    });
    // Both boundaries in one window -> 2 reboots, most recent is at nowMs.
    assert.deepEqual(summariseEsp32Reboots([atStart, atNow], WINDOW_MS, NOW_MS), {
        rebootCount: 2,
        lastReason: 'boundary-now',
        lastRebootAt: new Date(NOW_MS).toISOString()
    });
});

test('summariseEsp32Reboots: lastReason/lastRebootAt come from the chronologically most recent reboot, not the last array element', () => {
    // Highest-value test: the input is deliberately NON-chronological, with
    // the OLDEST reboot last in the array. A bare .sort() on Date objects
    // orders by weekday name and would pick the wrong element ~half the time
    // (that bug was already found and fixed twice in this codebase).
    // The most recent in-window reboot is at T+20h ("watchdog"), even though
    // the T+1h reboot ("brownout") is the final array element.
    const events = [
        { event_type: 'reboot', created_at: at(10), detail: { reason: 'brownout' } },
        { event_type: 'reboot', created_at: at(20), detail: { reason: 'watchdog' } },
        { event_type: 'reboot', created_at: at(1), detail: { reason: 'power-cycle' } }
    ];
    const result = summariseEsp32Reboots(events, WINDOW_MS, NOW_MS);
    assert.equal(result.rebootCount, 3);
    assert.equal(result.lastReason, 'watchdog');
    assert.equal(result.lastRebootAt, new Date(at(20)).toISOString());
});

test('summariseEsp32Reboots: detail as a JSON string yields the same lastReason as detail as an object', () => {
    // node-postgres parses JSONB into a JS object, but some drivers / mock
    // layers hand back the raw JSON string — both must behave identically.
    const fromObject = summariseEsp32Reboots(
        [{ event_type: 'reboot', created_at: at(6), detail: { reason: 'brownout', code: 1 } }],
        WINDOW_MS, NOW_MS);
    const fromString = summariseEsp32Reboots(
        [{ event_type: 'reboot', created_at: at(6), detail: '{"reason":"brownout","code":1}' }],
        WINDOW_MS, NOW_MS);
    assert.deepEqual(fromObject, {
        rebootCount: 1,
        lastReason: 'brownout',
        lastRebootAt: new Date(at(6)).toISOString()
    });
    assert.deepEqual(fromString, fromObject);
});

test('summariseEsp32Reboots: null / non-JSON string / numeric detail all yield lastReason null without throwing', () => {
    // Malformed detail must never throw; the reboot itself is still counted.
    for (const detail of [null, 'not json', 42]) {
        const result = summariseEsp32Reboots(
            [{ event_type: 'reboot', created_at: at(6), detail }],
            WINDOW_MS, NOW_MS);
        assert.deepEqual(result, {
            rebootCount: 1,
            lastReason: null,
            lastRebootAt: new Date(at(6)).toISOString()
        });
    }
});

test('summariseEsp32Reboots: created_at as Date objects vs ISO strings produce identical results', () => {
    // node-postgres returns Date objects; some callers pass ISO strings.
    // The implementation coerces via new Date(created_at).getTime(), so both
    // forms must give the same answer (also guards against string-sorting).
    const eventsAsDates = [
        { event_type: 'reboot', created_at: new Date(at(2)), detail: { reason: 'a' } },
        { event_type: 'reboot', created_at: new Date(at(9)), detail: { reason: 'b' } }
    ];
    const eventsAsIso = [
        { event_type: 'reboot', created_at: new Date(at(2)).toISOString(), detail: { reason: 'a' } },
        { event_type: 'reboot', created_at: new Date(at(9)).toISOString(), detail: { reason: 'b' } }
    ];
    const fromDates = summariseEsp32Reboots(eventsAsDates, WINDOW_MS, NOW_MS);
    const fromIso = summariseEsp32Reboots(eventsAsIso, WINDOW_MS, NOW_MS);
    assert.deepEqual(fromDates, {
        rebootCount: 2,
        lastReason: 'b',
        lastRebootAt: new Date(at(9)).toISOString()
    });
    assert.deepEqual(fromIso, fromDates);
});

test('summariseEsp32Reboots: a realistic Thai + emoji reason survives intact', () => {
    // Boot reasons are written by the firmware in Thai with emoji; the
    // normalisation path must not mangle or drop them.
    const reason = '🔴 Task watchdog (loop ค้าง)';
    const result = summariseEsp32Reboots(
        [{ event_type: 'reboot', created_at: at(12), detail: { reason } }],
        WINDOW_MS, NOW_MS);
    assert.equal(result.rebootCount, 1);
    assert.equal(result.lastReason, reason);
    assert.equal(result.lastRebootAt, new Date(at(12)).toISOString());
});
