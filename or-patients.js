'use strict';

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

class OrPatientError extends Error {
    constructor(message, { code = 'OR_PATIENT_ERROR', upstreamStatus = null } = {}) {
        super(message);
        this.name = 'OrPatientError';
        this.code = code;
        this.upstreamStatus = upstreamStatus;
    }
}

function validateWardCode(value) {
    if (typeof value !== 'string') {
        throw new OrPatientError('Ward code must be a string', { code: 'INVALID_WARD_CODE' });
    }
    const wardCode = value.trim();
    if (!wardCode || wardCode.length > 20 || /[\u0000-\u001f\u007f]/.test(wardCode)) {
        throw new OrPatientError('Ward code is invalid', { code: 'INVALID_WARD_CODE' });
    }
    return wardCode;
}

function validatePatientSearch(value) {
    if (typeof value !== 'string') {
        throw new OrPatientError('Patient search must be a string', { code: 'INVALID_PATIENT_SEARCH' });
    }
    const search = value.trim();
    if (!search || search.length > 100 || /[\u0000-\u001f\u007f]/.test(search)) {
        throw new OrPatientError('Patient search is invalid', { code: 'INVALID_PATIENT_SEARCH' });
    }
    return search;
}

function buildPatientsByWardUrl(baseUrl, search, {
    production = false,
    allowHttp = false
} = {}) {
    const configuredBaseUrl = typeof baseUrl === 'string' ? baseUrl.trim() : '';
    if (!configuredBaseUrl) {
        throw new OrPatientError('OR patient API base URL is not configured', { code: 'MISSING_BASE_URL' });
    }

    let root;
    try {
        root = new URL(`${configuredBaseUrl.replace(/\/+$/, '')}/`);
    } catch (_) {
        throw new OrPatientError('OR patient API base URL is invalid', { code: 'INVALID_BASE_URL' });
    }

    if (!['http:', 'https:'].includes(root.protocol)
        || root.username || root.password || root.search || root.hash) {
        throw new OrPatientError('OR patient API base URL is invalid', { code: 'INVALID_BASE_URL' });
    }
    if (production && !allowHttp && root.protocol !== 'https:') {
        throw new OrPatientError('OR patient API must use HTTPS in production', { code: 'INSECURE_BASE_URL' });
    }

    const url = new URL('get_patient.php', root);
    url.searchParams.set('search', validatePatientSearch(search));
    return url;
}

function validatePatientWardResponse(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || payload.status !== 'success' || !Array.isArray(payload.data)
        || !Number.isInteger(payload.count) || payload.count !== payload.data.length) {
        throw new OrPatientError('OR patient API returned an invalid response', { code: 'INVALID_RESPONSE' });
    }

    const seenHns = new Set();
    const data = payload.data.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)
            || typeof item.hn !== 'string' || typeof item.fullname !== 'string') {
            throw new OrPatientError('OR patient API returned invalid patient data', { code: 'INVALID_RESPONSE' });
        }

        const hn = item.hn.trim();
        const fullname = item.fullname.trim();
        const hnKey = hn.toLowerCase();
        if (!hn || !fullname || hn.length > 50 || fullname.length > 200 || seenHns.has(hnKey)) {
            throw new OrPatientError('OR patient API returned invalid patient data', { code: 'INVALID_RESPONSE' });
        }
        seenHns.add(hnKey);

        // Never pass through CID or any field outside the agreed minimum contract.
        return { hn, fullname };
    });

    return { status: 'success', count: data.length, data };
}

async function readResponseText(response) {
    if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const chunks = [];
        let totalBytes = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            totalBytes += chunk.length;
            if (totalBytes > MAX_RESPONSE_BYTES) {
                await reader.cancel().catch(() => {});
                throw new OrPatientError('OR patient API response is too large', { code: 'RESPONSE_TOO_LARGE' });
            }
            chunks.push(chunk);
        }
        return Buffer.concat(chunks, totalBytes).toString('utf8');
    }

    const responseText = await response.text();
    if (Buffer.byteLength(responseText, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new OrPatientError('OR patient API response is too large', { code: 'RESPONSE_TOO_LARGE' });
    }
    return responseText;
}

async function getCurrentPatientsByWard({
    baseUrl,
    wardCode,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    production = false,
    allowHttp = false,
    fetchImpl = globalThis.fetch
}) {
    if (typeof fetchImpl !== 'function') {
        throw new OrPatientError('Fetch implementation is unavailable', { code: 'FETCH_UNAVAILABLE' });
    }

    const url = buildPatientsByWardUrl(baseUrl, wardCode, { production, allowHttp });
    const parsedTimeout = Number(timeoutMs);
    const effectiveTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0
        ? parsedTimeout
        : DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    let timer;

    const operation = Promise.resolve().then(async () => {
        const response = await fetchImpl(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: controller.signal
        });
        if (!response || typeof response.ok !== 'boolean' || typeof response.text !== 'function') {
            throw new OrPatientError('OR patient API returned an invalid HTTP response', { code: 'INVALID_HTTP_RESPONSE' });
        }
        if (!response.ok) {
            throw new OrPatientError('OR patient API returned an HTTP error', {
                code: 'UPSTREAM_HTTP_ERROR',
                upstreamStatus: Number(response.status) || null
            });
        }

        const contentLength = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
            throw new OrPatientError('OR patient API response is too large', { code: 'RESPONSE_TOO_LARGE' });
        }
        const responseText = await readResponseText(response);

        let payload;
        try {
            payload = JSON.parse(responseText);
        } catch (_) {
            throw new OrPatientError('OR patient API returned invalid JSON', { code: 'INVALID_JSON' });
        }
        return validatePatientWardResponse(payload);
    });
    operation.catch(() => {});

    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new OrPatientError('OR patient API request timed out', { code: 'TIMEOUT' }));
        }, effectiveTimeoutMs);
    });

    try {
        return await Promise.race([operation, timeout]);
    } catch (error) {
        if (error instanceof OrPatientError) throw error;
        if (timedOut || error?.name === 'AbortError') {
            throw new OrPatientError('OR patient API request timed out', { code: 'TIMEOUT' });
        }
        throw new OrPatientError('Unable to reach OR patient API', { code: 'REQUEST_FAILED' });
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    DEFAULT_TIMEOUT_MS,
    MAX_RESPONSE_BYTES,
    OrPatientError,
    buildPatientsByWardUrl,
    getCurrentPatientsByWard,
    readResponseText,
    validatePatientSearch,
    validatePatientWardResponse,
    validateWardCode
};
