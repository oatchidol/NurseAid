'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    classifyAiQuestion,
    cleanAiText
} = require('../server.js');

test('classifyAiQuestion: naturally-phrased question with a selected patient routes to monitor_analysis (regression for the reported bug)', () => {
    assert.equal(classifyAiQuestion('เขาเป็นยังไงบ้าง', 'bed1'), 'monitor_analysis');
    assert.equal(classifyAiQuestion('มีอะไรน่าห่วงไหม', 'bed1'), 'monitor_analysis');
});

test('classifyAiQuestion: same natural question with no patient selected stays conversation', () => {
    assert.equal(classifyAiQuestion('เขาเป็นยังไงบ้าง', ''), 'conversation');
});

test('classifyAiQuestion: generic-knowledge question stays conversation even with a patient selected', () => {
    assert.equal(classifyAiQuestion('SpO2 คืออะไร', 'bed1'), 'conversation');
});

test('classifyAiQuestion: pure social messages stay conversation even with a patient selected', () => {
    assert.equal(classifyAiQuestion('สวัสดีครับ', 'bed1'), 'conversation');
    assert.equal(classifyAiQuestion('ขอบคุณค่ะ', 'bed1'), 'conversation');
});

test('classifyAiQuestion: explicit monitor keyword still routes to monitor_analysis with no patient selected', () => {
    assert.equal(classifyAiQuestion('เตียง 5 HR เท่าไหร่', ''), 'monitor_analysis');
});

test('classifyAiQuestion: a forced intentHint always wins first', () => {
    assert.equal(classifyAiQuestion('ช่วยแต่งกลอนเกี่ยวกับดอกไม้ให้หน่อย', '', 'monitor_analysis'), 'monitor_analysis');
});

test('classifyAiQuestion: accepted trade-off -- a fully off-topic question with a patient selected still routes to monitor_analysis', () => {
    // Adding a keyword blocklist for every possible off-topic phrasing is the exact
    // whack-a-mole this function's own looksLikeContinuation comment argues against.
    // This is a deliberate, reviewed trade-off, not a bug -- if this assertion ever
    // needs to change, that should be a discussed decision, not a silent side effect.
    assert.equal(classifyAiQuestion('ช่วยแต่งกลอนเกี่ยวกับดอกไม้ให้หน่อย', 'bed1'), 'monitor_analysis');
});

test('cleanAiText: trims, strips angle brackets, and truncates', () => {
    assert.equal(cleanAiText('  hello  ', 600), 'hello');
    assert.equal(cleanAiText('<script>alert(1)</script>', 600), 'scriptalert(1)/script');
    assert.equal(cleanAiText('a'.repeat(700), 600).length, 600);
});

test('cleanAiText: falsy input becomes an empty string, including the pre-existing 0-is-falsy quirk', () => {
    assert.equal(cleanAiText(null, 600), '');
    assert.equal(cleanAiText(undefined, 600), '');
    // Documented as current behavior, not "fixed" here: String(0 || '') === '' because
    // 0 is falsy. Out of scope for this change -- other call sites may rely on it.
    assert.equal(cleanAiText(0, 600), '');
});
