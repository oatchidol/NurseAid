'use strict';

// server.js ships the browser's JavaScript inside template literals. Inside a
// template literal a lone backslash before an unrecognised escape is simply
// dropped, so a regex written as /^\d{1,3}$/ in this file arrives in the browser
// as /^d{1,3}$/ -- which matches the letter d and rejects every digit. The bug is
// invisible in review (the source line looks right) and invisible to node --check
// (the file is valid JavaScript either way); it only shows up as a form that
// refuses correct input.
//
// This has already bitten twice: 8f5279c repaired a \s whitespace check on the
// WiFi form, and the MQTT broker address field rejected every valid IPv4 until
// the same fix was applied there. The rule is to double the backslash in source
// (\\d) so the browser receives \d.
//
// This test guards the whole class rather than those two sites.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

// Escapes that mean something in a regex and nothing in a string, so a lone
// backslash before them inside a template literal is always a mistake. String
// escapes that are legitimate on their own (\n, \t, \u, \$, \`) are excluded.
const REGEX_ONLY_ESCAPE = /\\([dDsSwWbB])/g;

function swallowedEscapes(file) {
    const src = fs.readFileSync(file, 'utf8');
    const ast = acorn.parse(src, { ecmaVersion: 2022 });
    const found = [];

    (function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'TemplateLiteral') {
            for (const quasi of node.quasis) {
                const raw = quasi.value.raw;
                REGEX_ONLY_ESCAPE.lastIndex = 0;
                let match;
                while ((match = REGEX_ONLY_ESCAPE.exec(raw)) !== null) {
                    // A doubled backslash reaches the browser intact — that is the fix,
                    // not the bug.
                    if (raw[match.index - 1] === '\\') continue;
                    const absolute = quasi.start + match.index;
                    const line = src.slice(0, absolute).split('\n').length;
                    found.push({
                        line,
                        escape: '\\' + match[1],
                        source: src.split('\n')[line - 1].trim()
                    });
                }
            }
        }
        for (const key of Object.keys(node)) {
            const value = node[key];
            if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value === 'object' && value.type) walk(value);
        }
    })(ast);

    return found;
}

test('no regex escape in server.js is swallowed by the template literal around it', () => {
    const hits = swallowedEscapes(path.join(__dirname, '..', 'server.js'));
    const report = hits
        .map(h => 'server.js:' + h.line + ' uses ' + h.escape + ' (browser receives '
            + h.escape.slice(1) + '): ' + h.source)
        .join('\n');
    assert.equal(
        hits.length,
        0,
        'Client-side regexes lose their backslash inside a template literal. '
        + 'Double it (\\\\d) so the browser receives \\d.\n' + report
    );
});

// Proves the failure mode the test above exists to catch, so a future reader does
// not have to take the explanation on trust.
test('a lone backslash escape really is dropped by a template literal', () => {
    const asWritten = '/^\\d{1,3}$/';
    const asDelivered = `/^\d{1,3}$/`;
    assert.equal(asWritten, '/^\\d{1,3}$/');
    assert.equal(asDelivered, '/^d{1,3}$/');
    assert.equal(new RegExp('^\\d{1,3}$').test('172'), true);
    assert.equal(new RegExp('^d{1,3}$').test('172'), false);
});
