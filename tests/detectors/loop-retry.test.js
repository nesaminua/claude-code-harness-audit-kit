'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const blockLoop = require('../../scripts/lib/detectors/block-loop');
const retry = require('../../scripts/lib/detectors/retry-verbatim');

const deps = { redact: (s) => s, truncate: (s, n) => s.slice(0, n) };
const config = { thresholds: { blockLoop: 3 } };
const S = 'alice-session-1';

let seq = 0;
const use = (over = {}) => {
  seq += 1;
  return { kind: 'tool_use', session: S, line: seq, ts: 't', id: `tu${seq}`, name: 'Bash',
    input: { command: `echo ${seq}` }, messageId: `m${seq}`, inputHash: `h${seq}`, ...over };
};
const blockOf = (tu, over = {}) => ({ kind: 'block', session: S, line: tu.line + 0.5, ts: 't',
  toolUseId: tu.id, hookEvent: 'PreToolUse', hook: '/home/alice/hooks/lint-guard.js',
  reason: 'lint failed in 3 files', ...over });

function run(mod, events, cfg = config) {
  const d = mod.create(cfg, deps);
  for (const ev of events) d.onEvent(ev);
  return d.finish();
}

function filler(n) {
  return Array.from({ length: n }, () => use());
}

test('3 identical blocks 5 calls apart make a loop', () => {
  const events = [];
  for (let i = 0; i < 3; i += 1) {
    const tu = use();
    events.push(tu, blockOf(tu, { reason: `lint failed in ${i + 10} files` }), ...filler(5));
  }
  const res = run(blockLoop, events);
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].rule, 'block-loop');
  assert.equal(res.findings[0].severity, 'high');
  assert.equal(res.findings[0].key, 'block-loop:lint-guard');
});

test('3 blocks with a gap of 25 calls make no loop', () => {
  const events = [];
  for (let i = 0; i < 3; i += 1) {
    const tu = use();
    events.push(tu, blockOf(tu), ...filler(25));
  }
  assert.equal(run(blockLoop, events).findings.length, 0);
});

test('blocked tool_uses sharing one messageId count once', () => {
  const events = [];
  for (let i = 0; i < 3; i += 1) {
    const tu = use({ messageId: 'shared' });
    events.push(tu, blockOf(tu));
  }
  assert.equal(run(blockLoop, events).findings.length, 0);
});

test('different reasons do not accumulate', () => {
  const events = [];
  for (const reason of ['one', 'two', 'three']) {
    const tu = use();
    events.push(tu, blockOf(tu, { reason }));
  }
  assert.equal(run(blockLoop, events).findings.length, 0);
});

test('a passed Stop round resets the count', () => {
  const stop = (over = {}) => {
    const tu = use();
    return [tu, blockOf(tu, { hookEvent: 'Stop', hook: 'secret-guard.js', ...over })];
  };
  const events = [
    ...stop(),
    use(), { kind: 'user_text', session: S, text: 'go on' },
    ...stop(),
    ...stop(),
  ];
  assert.equal(run(blockLoop, events).findings.length, 0);
});

test('Stop blocks without a passed round still loop', () => {
  const events = [];
  for (let i = 0; i < 3; i += 1) {
    const tu = use();
    events.push(tu, blockOf(tu, { hookEvent: 'Stop', hook: 'secret-guard.js' }));
  }
  assert.equal(run(blockLoop, events).findings.length, 1);
});

test('emits once per session and key', () => {
  const events = [];
  for (let i = 0; i < 6; i += 1) {
    const tu = use();
    events.push(tu, blockOf(tu));
  }
  assert.equal(run(blockLoop, events).findings.length, 1);
});

test('threshold comes from config', () => {
  const events = [];
  for (let i = 0; i < 2; i += 1) {
    const tu = use();
    events.push(tu, blockOf(tu));
  }
  assert.equal(run(blockLoop, events, { thresholds: { blockLoop: 2 } }).findings.length, 1);
  assert.equal(run(blockLoop, events, {}).findings.length, 0);
});

test('block-loop exposure maps are filled', () => {
  const tu = use();
  const res = run(blockLoop, [tu, blockOf(tu)]);
  assert.ok(res.exposedSessions instanceof Set);
  assert.ok(res.exposedSessions.has(S));
  assert.ok(res.exposureByKey.get('block-loop:lint-guard').has(S));
});

test('PostToolUse block then identical call is no retry', () => {
  const a = use({ inputHash: 'same' });
  const b = use({ inputHash: 'same' });
  const res = run(retry, [a, blockOf(a, { hookEvent: 'PostToolUse' }), b]);
  assert.equal(res.findings.length, 0);
});

test('PreToolUse block then identical call is a retry', () => {
  const a = use({ inputHash: 'same' });
  const b = use({ inputHash: 'same' });
  const res = run(retry, [a, blockOf(a), b]);
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].rule, 'retry-verbatim');
  assert.equal(res.findings[0].severity, 'medium');
  assert.equal(res.findings[0].key, 'retry-verbatim:lint-guard');
});

test('PermissionRequest block then identical call is a retry', () => {
  const a = use({ inputHash: 'same' });
  const b = use({ inputHash: 'same' });
  const res = run(retry, [a, blockOf(a, { hookEvent: 'PermissionRequest' }), b]);
  assert.equal(res.findings.length, 1);
});

const VALUE = 'Zq8xKp2mWv91';
const hasRun = (text) => {
  for (let i = 0; i + 6 <= VALUE.length; i += 1) if (text.includes(VALUE.slice(i, i + 6))) return true;
  return false;
};

test('minimisation: retry-verbatim stores the call shape, never argument values', () => {
  const input = { command: `deploy --token ${VALUE} --env prod-${VALUE}` };
  const a = use({ input, inputHash: 'same' });
  const b = use({ input, inputHash: 'same' });
  const res = run(retry, [a, blockOf(a), b]);
  assert.equal(res.findings.length, 1);
  assert.equal(hasRun(JSON.stringify(res.findings)), false);
  assert.match(res.findings[0].summary, /: deploy --token … --env …$/);
});

test('minimisation: retry-verbatim stores a file tool as name and basename only', () => {
  const input = { file_path: '/home/alice/proj/a.js', old_string: VALUE, new_string: VALUE };
  const a = use({ name: 'Edit', input, inputHash: 'same' });
  const b = use({ name: 'Edit', input, inputHash: 'same' });
  const res = run(retry, [a, blockOf(a), b]);
  assert.equal(hasRun(JSON.stringify(res.findings)), false);
  assert.match(res.findings[0].summary, /: Edit a\.js$/);
  assert.equal(JSON.stringify(res.findings).includes('/home/alice'), false);
});

test('minimisation: block-loop keeps the reason and adds the blocked call shape', () => {
  const events = [];
  for (let i = 0; i < 3; i += 1) {
    const tu = use({ input: { command: `psql -c "select ${VALUE}" --host db-${VALUE}` } });
    events.push(tu, blockOf(tu));
  }
  const res = run(blockLoop, events);
  assert.equal(res.findings.length, 1);
  assert.equal(hasRun(JSON.stringify(res.findings)), false);
  assert.equal(res.findings[0].evidence[0], 'lint failed in 3 files');
  assert.equal(res.findings[0].evidence[1], 'blocked call: psql -c … --host …');
});

test('PreToolUse block then a changed call is no retry', () => {
  const a = use({ inputHash: 'one' });
  const b = use({ inputHash: 'two' });
  assert.equal(run(retry, [a, blockOf(a), b]).findings.length, 0);
});

test('only the very next call counts as a retry', () => {
  const a = use({ inputHash: 'same' });
  const mid = use({ inputHash: 'other' });
  const c = use({ inputHash: 'same' });
  assert.equal(run(retry, [a, blockOf(a), mid, c]).findings.length, 0);
});

test('retry exposure maps hold only PreToolUse and PermissionRequest blocks', () => {
  const a = use();
  const b = use();
  const res = run(retry, [a, blockOf(a), b, blockOf(b, { hookEvent: 'PostToolUse', hook: 'other.js' })]);
  assert.ok(res.exposedSessions.has(S));
  assert.ok(res.exposureByKey.get('retry-verbatim:lint-guard').has(S));
  assert.equal(res.exposureByKey.has('retry-verbatim:other'), false);
});
