'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    MAX_RESPONSE_BYTES,
    OrPatientError,
    buildPatientsByWardUrl,
    getCurrentPatientsByWard,
    validatePatientWardResponse
} = require('../or-patients');

function response(payload, { status = 200, rawBody, contentLength } = {}) {
    const body = rawBody === undefined ? JSON.stringify(payload) : rawBody;
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: name => name.toLowerCase() === 'content-length' ? contentLength ?? null : null },
        text: async () => body
    };
}

test('builds the endpoint with ward 08 preserved as a string', () => {
    const url = buildPatientsByWardUrl('https://his.example.test/or_patient', '08', { production: true });
    assert.equal(url.toString(), 'https://his.example.test/or_patient/get_patients_by_ward.php?ward=08');
});

test('supports another exact ward code without numeric conversion', () => {
    const url = buildPatientsByWardUrl('https://his.example.test/or_patient/', 'A-03');
    assert.equal(url.searchParams.get('ward'), 'A-03');
});

test('rejects an HTTP provider URL in production', () => {
    assert.throws(
        () => buildPatientsByWardUrl('http://his.example.test/or_patient', '08', { production: true }),
        error => error instanceof OrPatientError && error.code === 'INSECURE_BASE_URL'
    );
});

test('rejects a missing provider base URL', async () => {
    await assert.rejects(
        getCurrentPatientsByWard({ baseUrl: '', wardCode: '08' }),
        error => error.code === 'MISSING_BASE_URL'
    );
});

test('preserves leading-zero HNs and removes fields outside the contract', async () => {
    const result = await getCurrentPatientsByWard({
        baseUrl: 'https://his.example.test/or_patient',
        wardCode: '08',
        production: true,
        fetchImpl: async url => {
            assert.equal(url.searchParams.get('ward'), '08');
            return response({
                status: 'success',
                count: 1,
                data: [{ hn: '000000001', fullname: 'ผู้ป่วยทดสอบ ก', cid: 'not-returned' }]
            });
        }
    });

    assert.deepEqual(result, {
        status: 'success',
        count: 1,
        data: [{ hn: '000000001', fullname: 'ผู้ป่วยทดสอบ ก' }]
    });
});

test('accepts an empty successful census', () => {
    assert.deepEqual(validatePatientWardResponse({ status: 'success', count: 0, data: [] }), {
        status: 'success', count: 0, data: []
    });
});

test('rejects a count mismatch', () => {
    assert.throws(
        () => validatePatientWardResponse({ status: 'success', count: 2, data: [] }),
        error => error.code === 'INVALID_RESPONSE'
    );
});

test('rejects non-string patient fields', () => {
    assert.throws(
        () => validatePatientWardResponse({
            status: 'success', count: 1, data: [{ hn: 1, fullname: 'ผู้ป่วยทดสอบ ก' }]
        }),
        error => error.code === 'INVALID_RESPONSE'
    );
});

test('rejects duplicate HNs', () => {
    assert.throws(
        () => validatePatientWardResponse({
            status: 'success',
            count: 2,
            data: [
                { hn: '000000001', fullname: 'ผู้ป่วยทดสอบ ก' },
                { hn: '000000001', fullname: 'ผู้ป่วยทดสอบ ข' }
            ]
        }),
        error => error.code === 'INVALID_RESPONSE'
    );
});

test('rejects malformed JSON', async () => {
    await assert.rejects(
        getCurrentPatientsByWard({
            baseUrl: 'https://his.example.test/or_patient',
            wardCode: '08',
            fetchImpl: async () => response(null, { rawBody: '<html>not json</html>' })
        }),
        error => error.code === 'INVALID_JSON'
    );
});

test('rejects an upstream HTTP failure without reading its body', async () => {
    await assert.rejects(
        getCurrentPatientsByWard({
            baseUrl: 'https://his.example.test/or_patient',
            wardCode: '08',
            fetchImpl: async () => response(null, { status: 503, rawBody: 'internal details' })
        }),
        error => error.code === 'UPSTREAM_HTTP_ERROR' && error.upstreamStatus === 503
    );
});

test('turns a network failure into a safe client error', async () => {
    await assert.rejects(
        getCurrentPatientsByWard({
            baseUrl: 'https://his.example.test/or_patient',
            wardCode: '08',
            fetchImpl: async () => { throw new Error('connection details must not escape'); }
        }),
        error => error.code === 'REQUEST_FAILED' && !error.message.includes('connection details')
    );
});

test('times out an unresponsive provider', async () => {
    await assert.rejects(
        getCurrentPatientsByWard({
            baseUrl: 'https://his.example.test/or_patient',
            wardCode: '08',
            timeoutMs: 5,
            fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
            })
        }),
        error => error.code === 'TIMEOUT'
    );
});

test('rejects a response larger than one megabyte', async () => {
    await assert.rejects(
        getCurrentPatientsByWard({
            baseUrl: 'https://his.example.test/or_patient',
            wardCode: '08',
            fetchImpl: async () => response({}, { contentLength: MAX_RESPONSE_BYTES + 1 })
        }),
        error => error.code === 'RESPONSE_TOO_LARGE'
    );
});

test('rejects an oversized body when content-length is absent', async () => {
    await assert.rejects(
        getCurrentPatientsByWard({
            baseUrl: 'https://his.example.test/or_patient',
            wardCode: '08',
            fetchImpl: async () => response(null, { rawBody: 'x'.repeat(MAX_RESPONSE_BYTES + 1) })
        }),
        error => error.code === 'RESPONSE_TOO_LARGE'
    );
});
