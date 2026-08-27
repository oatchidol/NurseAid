#!/usr/bin/env node
/*
 * check-offline-assets.js
 *
 * Regression guard for the "no outbound internet" property of the NurseAid UI.
 *
 * NurseAid runs inside hospital networks that cannot reach the public internet.
 * The whole UI is server-rendered as inline HTML template strings in server.js,
 * and it was migrated off external CDNs (cdn.tailwindcss.com, cdn.jsdelivr.net,
 * unpkg.com, fonts.googleapis.com, fonts.gstatic.com, actions.google.com) onto
 * files served locally from public/assets/. If a CDN URL is pasted back in, the
 * page still renders during development (the dev machine has internet) and only
 * breaks on the ward -- silently, at the worst possible moment. This script makes
 * that failure loud and cheap to catch.
 *
 * Checks:
 *   1. No external asset URLs in served HTML  -- <script src>, <link href>, media
 *      src attributes pointing at http(s), plus any reference to a known CDN host.
 *      Human-facing <a href="https://..."> links and JavaScript logic that talks to
 *      external APIs (api.github.com, api.telegram.org, ...) are deliberately NOT
 *      flagged: a guard that cries wolf gets ignored and then deleted.
 *   2. Every local /assets/... reference in server.js resolves to a real file.
 *   3. Every url(...) in public/assets/fonts.css resolves to a real file.
 *   4. public/assets/tailwind.css is not obviously staler than server.js (warning).
 *
 * Usage: node scripts/check-offline-assets.js
 * Exit code: 1 if any check FAILs, otherwise 0. Warnings never affect the exit code.
 * Node built-ins only, no dependencies.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SERVER_JS = path.join(ROOT, 'server.js');
const PUBLIC_DIR = path.join(ROOT, 'public');
const ASSETS_DIR = path.join(PUBLIC_DIR, 'assets');
const FONTS_CSS = path.join(ASSETS_DIR, 'fonts.css');
const TAILWIND_CSS = path.join(ASSETS_DIR, 'tailwind.css');

// Hosts the UI was migrated off, plus common CDNs someone might reach for next.
// Matched as exact host or subdomain, and only when carrying an http(s):// scheme,
// so prose that merely names a host (migration notes) is not flagged.
const CDN_HOSTS = [
    'cdn.tailwindcss.com',
    'cdn.jsdelivr.net',
    'unpkg.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'actions.google.com',
    'cdnjs.cloudflare.com',
    'ajax.googleapis.com',
    'code.jquery.com',
    'stackpath.bootstrapcdn.com',
    'maxcdn.bootstrapcdn.com',
    'esm.sh',
    'cdn.skypack.dev'
];

// Tags whose src= attribute pulls a subresource the browser must fetch.
const MEDIA_SRC_TAGS = new Set([
    'script', 'img', 'audio', 'video', 'iframe', 'source', 'embed', 'track', 'input'
]);

const MAX_TEXT = 150;

// ---------------------------------------------------------------- helpers

function readIfExists(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

/**
 * Blank out <!-- ... --> comments, preserving byte offsets and line numbers, so
 * that documentation prose and commented-out markup cannot trip the scanners.
 */
function blankHtmlComments(text) {
    return text.replace(/<!--[\s\S]*?-->/g, (match) =>
        match.replace(/[^\n]/g, ' ')
    );
}

/** Build a line-start offset table for fast offset -> 1-based line lookup. */
function buildLineTable(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') starts.push(i + 1);
    }
    return starts;
}

function offsetToLine(starts, offset) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset) lo = mid;
        else hi = mid - 1;
    }
    return lo + 1;
}

function lineTextAt(text, starts, line) {
    const start = starts[line - 1];
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    return text.slice(start, end);
}

function snippet(str) {
    const trimmed = str.trim();
    return trimmed.length > MAX_TEXT ? trimmed.slice(0, MAX_TEXT) + '...' : trimmed;
}

/**
 * Given an offset that sits inside an attribute, walk backwards to find the tag
 * that encloses it. Returns the lowercased tag name, or null when the offset is
 * not inside an HTML tag at all (i.e. it is plain JavaScript). Callers match the
 * result against an allowlist, so an ambiguous answer is always treated as
 * "not an HTML asset attribute" and skipped.
 */
function enclosingTagName(text, attrOffset) {
    const LIMIT = 4000; // tags are never longer than this in practice
    const floor = Math.max(0, attrOffset - LIMIT);
    for (let i = attrOffset; i >= floor; i--) {
        const ch = text[i];
        if (ch === '>') return null;   // walked out of a tag: this is not markup
        if (ch === '<') {
            const m = /^<\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(text.slice(i, i + 48));
            return m ? m[1].toLowerCase() : null;
        }
    }
    return null;
}

function hostOf(url) {
    const m = /^https?:\/\/([^/?#"'`\s\\]+)/i.exec(url);
    if (!m) return null;
    return m[1].replace(/^.*@/, '').replace(/:\d+$/, '').toLowerCase();
}

function isCdnHost(host) {
    if (!host) return false;
    return CDN_HOSTS.some((cdn) => host === cdn || host.endsWith('.' + cdn));
}

// ---------------------------------------------------------------- check 1

/**
 * Scan served HTML for external asset URLs.
 *   - src="http..."  on script/img/audio/video/iframe/... tags
 *   - href="http..." where the enclosing tag is <link>
 *   - any http(s) URL pointing at a known CDN host, wherever it appears
 *     (this is what catches a CDN media URL handed to new Audio(...) in
 *     client-side JS, which no attribute rule would ever see)
 * Explicitly not flagged: <a href="https://...">, and JS calls to external
 * APIs such as fetch('https://api.github.com/...').
 */
function checkNoExternalAssets(rawText) {
    const problems = [];
    const text = blankHtmlComments(rawText);
    const starts = buildLineTable(text);
    const seen = new Set();

    const add = (offset, reason) => {
        const line = offsetToLine(starts, offset);
        const key = line + '|' + reason;
        if (seen.has(key)) return;
        seen.add(key);
        problems.push({
            file: SERVER_JS,
            line,
            text: snippet(lineTextAt(text, starts, line)),
            reason
        });
    };

    // src="http..." / src='http...'
    const srcRe = /\bsrc\s*=\s*("|')(https?:\/\/[^"'`]*)\1/gi;
    let m;
    while ((m = srcRe.exec(text)) !== null) {
        const tag = enclosingTagName(text, m.index);
        if (tag && MEDIA_SRC_TAGS.has(tag)) {
            add(m.index, 'external <' + tag + ' src="..."> (host ' + hostOf(m[2]) + ')');
        }
    }

    // href="http..." but only inside <link ...>
    const hrefRe = /\bhref\s*=\s*("|')(https?:\/\/[^"'`]*)\1/gi;
    while ((m = hrefRe.exec(text)) !== null) {
        const tag = enclosingTagName(text, m.index);
        if (tag === 'link') {
            add(m.index, 'external <link href="..."> (host ' + hostOf(m[2]) + ')');
        }
    }

    // Known CDN hosts anywhere (scheme required, so prose mentions are ignored).
    const urlRe = /https?:\/\/[^\s"'`)<>\\]+/gi;
    while ((m = urlRe.exec(text)) !== null) {
        const host = hostOf(m[0]);
        if (isCdnHost(host)) {
            add(m.index, 'known CDN host "' + host + '" is unreachable offline');
        }
    }

    return problems;
}

// ---------------------------------------------------------------- check 2

/** Every src="/assets/..." and href="/assets/..." must resolve under public/. */
function checkLocalAssetsResolve(rawText) {
    const problems = [];
    const text = blankHtmlComments(rawText);
    const starts = buildLineTable(text);
    const re = /\b(?:src|href)\s*=\s*("|')(\/assets\/[^"'`]*)\1/gi;
    let m;

    while ((m = re.exec(text)) !== null) {
        const ref = m[2];
        const clean = ref.split('?')[0].split('#')[0];
        const resolved = path.resolve(PUBLIC_DIR, '.' + clean);
        if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
            problems.push({
                file: SERVER_JS,
                line: offsetToLine(starts, m.index),
                text: snippet(ref),
                reason: 'asset path escapes public/'
            });
            continue;
        }
        if (!fs.existsSync(resolved)) {
            problems.push({
                file: SERVER_JS,
                line: offsetToLine(starts, m.index),
                text: snippet(ref),
                reason: 'missing file ' + path.relative(ROOT, resolved)
            });
        }
    }

    return problems;
}

// ---------------------------------------------------------------- check 3

/** Every url(...) in fonts.css must resolve relative to the CSS file's own dir. */
function checkCssUrls() {
    const css = readIfExists(FONTS_CSS);
    if (css === null) return { skipped: true, problems: [] };

    const problems = [];
    const starts = buildLineTable(css);
    const baseDir = path.dirname(FONTS_CSS);
    const re = /url\(\s*("|'|)([^)"']+)\1\s*\)/gi;
    let m;

    while ((m = re.exec(css)) !== null) {
        const ref = m[2].trim();
        if (!ref || /^(data:|about:)/i.test(ref)) continue;

        const line = offsetToLine(starts, m.index);
        if (/^https?:\/\//i.test(ref) || ref.startsWith('//')) {
            problems.push({
                file: FONTS_CSS,
                line,
                text: snippet(ref),
                reason: 'external url() is unreachable offline'
            });
            continue;
        }

        const clean = ref.split('?')[0].split('#')[0];
        const resolved = clean.startsWith('/')
            ? path.resolve(PUBLIC_DIR, '.' + clean)
            : path.resolve(baseDir, clean);

        if (!fs.existsSync(resolved)) {
            problems.push({
                file: FONTS_CSS,
                line,
                text: snippet(ref),
                reason: 'missing file ' + path.relative(ROOT, resolved)
            });
        }
    }

    return { skipped: false, problems };
}

// ---------------------------------------------------------------- check 4

/**
 * tailwind.css is generated by scanning server.js, so it can fall out of date.
 *
 * Deliberately NOT an mtime comparison. Tailwind skips writing the output file
 * when the generated CSS is byte-identical, so after a no-op rebuild server.js
 * stays newer than tailwind.css forever. An mtime check therefore warns on every
 * edit that touches no utility class -- most edits -- and a warning that is
 * usually wrong is a warning people learn to ignore.
 *
 * Instead: rebuild to a temp file and compare content. That is the only thing
 * that actually answers "would committing a rebuild change anything?".
 * If the tailwindcss devDependency is absent (production installs use
 * `npm ci --only=production`), skip rather than guess.
 */
function checkTailwindFreshness() {
    const warnings = [];

    if (!fs.existsSync(TAILWIND_CSS)) {
        warnings.push('public/assets/tailwind.css is missing - run: npm run build:css');
        return warnings;
    }

    const binary = path.join(ROOT, 'node_modules', '.bin', 'tailwindcss');
    if (!fs.existsSync(binary)) {
        warnings.push('tailwindcss not installed - skipped the CSS freshness check');
        return warnings;
    }

    const tmp = path.join(os.tmpdir(), 'nurseaid-tailwind-freshness-' + process.pid + '.css');
    try {
        cp.execFileSync(binary, [
            '-c', path.join(ROOT, 'tailwind.config.js'),
            '-i', path.join(ROOT, 'src', 'tailwind-input.css'),
            '-o', tmp, '--minify'
        ], { cwd: ROOT, stdio: 'ignore' });

        const fresh = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
        const committed = crypto.createHash('sha256').update(fs.readFileSync(TAILWIND_CSS)).digest('hex');
        if (fresh !== committed) {
            warnings.push(
                'public/assets/tailwind.css does not match a fresh build of server.js - ' +
                'run: npm run build:css, then commit the result'
            );
        }
    } catch (e) {
        warnings.push('could not rebuild CSS to verify freshness: ' + e.message);
    } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
    }
    return warnings;
}

// ---------------------------------------------------------------- reporting

function printProblems(problems) {
    for (const p of problems) {
        console.log(
            '    ' + path.relative(ROOT, p.file) + ':' + p.line + ': ' + p.reason
        );
        console.log('      | ' + p.text);
    }
}

function main() {
    const server = readIfExists(SERVER_JS);
    if (server === null) {
        console.log('ERROR: cannot read ' + SERVER_JS);
        console.log('check-offline-assets: FAIL (1 problems)');
        process.exit(1);
    }

    const results = [];

    const c1 = checkNoExternalAssets(server);
    results.push({ name: 'no external asset URLs in served HTML', problems: c1 });

    const c2 = checkLocalAssetsResolve(server);
    results.push({ name: 'local /assets/ references resolve', problems: c2 });

    const c3 = checkCssUrls();
    results.push({
        name: 'fonts.css url() references resolve',
        problems: c3.problems,
        skipped: c3.skipped
    });

    const warnings = checkTailwindFreshness();

    console.log('check-offline-assets: scanning ' + path.relative(ROOT, SERVER_JS));
    console.log('');

    let total = 0;
    for (const r of results) {
        const status = r.skipped ? 'SKIPPED' : r.problems.length ? 'FAIL' : 'PASS';
        const count = r.skipped ? 0 : r.problems.length;
        console.log('[' + status + '] ' + r.name + ' (' + count + ' problems)');
        total += count;
    }

    const warnStatus = warnings.length ? 'WARN' : 'PASS';
    console.log('[' + warnStatus + '] tailwind.css build freshness (0 problems)');

    if (results.some((r) => !r.skipped && r.problems.length)) {
        console.log('');
        console.log('Problems:');
        for (const r of results) {
            if (r.skipped || !r.problems.length) continue;
            console.log('  ' + r.name + ':');
            printProblems(r.problems);
        }
    }

    if (warnings.length) {
        console.log('');
        console.log('Warnings (do not affect exit code):');
        for (const w of warnings) console.log('    ' + w);
    }

    console.log('');
    if (total > 0) {
        console.log('check-offline-assets: FAIL (' + total + ' problems)');
        process.exit(1);
    }
    console.log('check-offline-assets: PASS');
    process.exit(0);
}

module.exports = {
    checkNoExternalAssets,
    checkLocalAssetsResolve,
    checkCssUrls,
    checkTailwindFreshness,
    blankHtmlComments,
    enclosingTagName,
    isCdnHost,
    hostOf
};

if (require.main === module) {
    main();
}
