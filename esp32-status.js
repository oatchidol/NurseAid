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
        const jstyleMacs = [];
        for (const rawWatch of watches) {
            if (!rawWatch || typeof rawWatch !== 'object') continue;
            const watchMac = canonicalMac(rawWatch.watchId);
            if (watchMac && !jstyleMacs.includes(watchMac)) jstyleMacs.push(watchMac);
        }

        const rawStatus = VALID_STATUS.has(rawNode.status) ? rawNode.status : 'unknown';
        const status = sourceStale || !ready ? 'unknown' : rawStatus;
        const reportedCount = Number.isInteger(rawNode.connectedJstyleCount) && rawNode.connectedJstyleCount >= 0
            ? rawNode.connectedJstyleCount
            : null;
        const connectedJstyleCount = status === 'connected'
            ? (reportedCount === null ? jstyleMacs.length : reportedCount)
            : 0;

        nodes.push({
            nodeId,
            boardMac,
            ipAddress,
            status,
            connectedJstyleCount,
            jstyleMacs,
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

module.exports = {
    canonicalMac,
    parseEsp32Topology,
    readEsp32Topology,
    readMqttClientIps
};
