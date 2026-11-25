'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { finding, redactKey } = require('../../scripts/lib/detectors/util.js');

const detector = { id: 'block-loop', severity: 'medium' };
const ev = { session: 'abcdefghij', line: 1, ts: '2026-11-20T12:00:00' };
const secret = 'sk-' + 'ant-api03-' + 'A'.repeat(24);

test('hook and the hook part of the key are redacted', () => {
  const hook = `guard-${secret}`;
  const f = finding(detector, ev, { key: `block-loop:${hook}`, hook, summary: 's' });
  assert.ok(!f.hook.includes(secret) && !f.key.includes(secret), JSON.stringify(f));
  assert.match(f.hook, /<redacted:/);
  assert.match(f.key, /^block-loop:guard-<redacted:/);
});

test('a home path in the hook is masked and the rule prefix of the key survives', () => {
  const hook = '/Users/alice/dev/acme/hooks/lint-guard';
  const f = finding(detector, ev, { key: `block-loop:${hook}`, hook, summary: 's' }, undefined);
  assert.ok(!f.hook.includes('alice') && !f.key.includes('alice'), JSON.stringify(f));
  assert.ok(f.key.startsWith('block-loop:'));
});

test('a clean hook and key pass through unchanged, null hook stays null', () => {
  const f = finding(detector, ev, { key: 'block-loop:lint-guard', hook: 'lint-guard', summary: 's' });
  assert.equal(f.key, 'block-loop:lint-guard');
  assert.equal(f.hook, 'lint-guard');
  assert.equal(finding(detector, ev, { key: 'k', summary: 's' }).hook, null);
});

test('redactKey(key) equals the key finding() stores, so exposure keys can be mapped to match', () => {
  const key = `block-loop:guard-${secret}`;
  const f = finding(detector, ev, { key, hook: `guard-${secret}`, summary: 's' });
  assert.equal(redactKey(key), f.key);
  assert.ok(!redactKey(key).includes(secret));
  assert.equal(redactKey('block-loop:lint-guard'), 'block-loop:lint-guard');
  assert.equal(redactKey('no-colon'), 'no-colon');
});
