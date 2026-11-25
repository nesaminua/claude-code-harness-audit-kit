'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const q = require('../scripts/lib/queue.js');

const finding = (over = {}) => ({
  rule: 'retry-verbatim', severity: 'medium', key: 'k1', session: 's1', line: 3,
  ts: '2026-11-20T12:00:00', hook: null, summary: 'first summary', evidence: ['e1'], ...over,
});
const empty = () => ({ version: 1, open: [], resolved: [], expired: [], dismissed: [] });

test('item shape and id', () => {
  const queue = q.upsert(empty(), [finding()]);
  const [it] = queue.open;
  assert.equal(it.id, crypto.createHash('sha1').update('k1').digest('hex').slice(0, 8));
  assert.equal(it.title, 'first summary');
  assert.equal(it.first_seen, '2026-11-20');
  assert.equal(it.last_seen, '2026-11-20');
  assert.deepEqual(it.hitIds, ['s1|2026-11-20']);
  assert.equal(it.hits, 1);
  assert.equal(it.sessions, 1);
  assert.deepEqual(it.examples, [{ session: 's1', day: '2026-11-20', hook: null, summary: 'first summary', evidence: ['e1'] }]);
});

test('same-day re-upsert does not double-count', () => {
  const queue = q.upsert(empty(), [finding()]);
  q.upsert(queue, [finding({ line: 9 })]);
  assert.equal(queue.open.length, 1);
  assert.equal(queue.open[0].hits, 1);
});

test('counts hits, sessions, days; examples capped at 3 newest first', () => {
  const queue = empty();
  q.upsert(queue, [
    finding({ ts: '2026-11-18T10:00:00', summary: 'a' }),
    finding({ ts: '2026-11-19T10:00:00', summary: 'b', session: 's2' }),
    finding({ ts: '2026-11-20T10:00:00', summary: 'c' }),
    finding({ ts: '2026-11-21T10:00:00', summary: 'd' }),
  ]);
  const [it] = queue.open;
  assert.equal(it.hits, 4);
  assert.equal(it.sessions, 2);
  assert.deepEqual(it.seen_days, ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21']);
  assert.equal(it.first_seen, '2026-11-18');
  assert.equal(it.last_seen, '2026-11-21');
  assert.equal(it.title, 'a');
  assert.deepEqual(it.examples.map((e) => e.summary), ['d', 'c', 'b']);
});

test('dismissed key stays out', () => {
  const queue = q.upsert(empty(), [finding()]);
  q.dismiss(queue, queue.open[0].id, 'noise', '2026-11-21T00:00:00');
  assert.equal(queue.open.length, 0);
  assert.deepEqual(queue.dismissed, [{ key: 'k1', reason: 'noise', at: '2026-11-21T00:00:00' }]);
  q.upsert(queue, [finding({ ts: '2026-11-22T10:00:00' })]);
  assert.equal(queue.open.length, 0);
});

test('resolve returns the ledger row and moves the item', () => {
  const queue = q.upsert(empty(), [finding()]);
  const row = q.resolve(queue, queue.open[0].id, 'fixed hook', '2026-11-21T09:00:00');
  assert.deepEqual(row, {
    key: 'k1', rule: 'retry-verbatim', date: '2026-11-21',
    resolved_at: '2026-11-21T09:00:00', note: 'fixed hook',
  });
  assert.equal(queue.open.length, 0);
  assert.equal(queue.resolved[0].note, 'fixed hook');
});

test('unknown id throws a clear error', () => {
  assert.throws(() => q.resolve(empty(), 'deadbeef', 'n', '2026-11-21T00:00:00'), /deadbeef/);
  assert.throws(() => q.dismiss(empty(), 'deadbeef', 'n', '2026-11-21T00:00:00'), /deadbeef/);
});

test('hit before resolved_at does not reopen; after it does', () => {
  const queue = q.upsert(empty(), [finding()]);
  q.resolve(queue, queue.open[0].id, 'n', '2026-11-21T09:00:00');
  q.upsert(queue, [finding({ ts: '2026-11-20T20:00:00', session: 's9' })]);
  assert.equal(queue.open.length, 0);
  assert.equal(queue.resolved[0].hits, 1);
  q.upsert(queue, [finding({ ts: '2026-11-22T08:00:00', session: 's2' })]);
  assert.equal(queue.resolved.length, 0);
  assert.equal(queue.open.length, 1);
  assert.equal(queue.open[0].reopened, true);
  assert.equal(queue.open[0].resolved_at, undefined);
  assert.equal(queue.open[0].hits, 2);
});

test('expire moves a stale item only', () => {
  const queue = q.upsert(empty(), [
    finding({ key: 'old', ts: '2026-10-01T10:00:00' }),
    finding({ key: 'new', ts: '2026-11-20T10:00:00' }),
  ]);
  q.expire(queue, '2026-11-25', 14);
  assert.deepEqual(queue.open.map((i) => i.key), ['new']);
  assert.deepEqual(queue.expired.map((i) => i.key), ['old']);
  q.expire(queue, '2026-12-04', 14);
  assert.equal(queue.open.length, 1);
  q.expire(queue, '2026-12-05', 14);
  assert.equal(queue.open.length, 0);
});

test('ordered: severity weight x seen days, ties by newer last_seen', () => {
  const two = (key, severity, a, b) => [
    finding({ key, severity, ts: `${a}T10:00:00` }),
    finding({ key, severity, ts: `${b}T10:00:00` }),
  ];
  const queue = empty();
  q.upsert(queue, [
    ...two('med', 'medium', '2026-11-19', '2026-11-20'),
    ...two('high', 'high', '2026-11-10', '2026-11-11'),
    ...two('low-new', 'low', '2026-11-23', '2026-11-24'),
    ...two('low-old', 'low', '2026-11-21', '2026-11-22'),
    finding({ key: 'low1', severity: 'low' }),
  ]);
  assert.deepEqual(q.ordered(queue).map((i) => i.key), ['high', 'med', 'low-new', 'low-old', 'low1']);
});

test('save/load round-trip, no tmp file left', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hak-'));
  const file = path.join(dir, 'nested', 'queue.json');
  const queue = q.upsert(empty(), [finding()]);
  q.save(queue, file);
  assert.deepEqual(q.load(file), queue);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['queue.json']);
});

test('load: missing file is an empty queue; corrupt JSON names the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hak-'));
  assert.deepEqual(q.load(path.join(dir, 'none.json')), empty());
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{nope');
  assert.throws(() => q.load(bad), (e) => e instanceof Error && e.message.includes(bad));
});

test('C3-1: a saved queue is user-only, whether the file is new or an older one was 0644', { skip: process.platform === 'win32' && 'file modes are POSIX only' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hak-mode-'));
  const file = path.join(dir, 'data', 'queue.json');
  q.save(q.load(file), file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.chmodSync(file, 0o644);
  q.save(q.load(file), file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-')), []);
});

for (const [name, content, shape] of [['null', 'null', 'null'], ['an array', '[1]', 'an array'], ['a number', '7', 'a number']]) {
  test(`C1-2: a queue file holding ${name} is moved aside, the queue starts empty and a warning names it`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hak-null-'));
    const file = path.join(dir, 'queue.json');
    fs.writeFileSync(file, content);
    const warnings = [];
    const loaded = q.load(file, (w) => warnings.push(w));
    assert.deepEqual(loaded.open, []);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('queue.json.corrupt-')).length, 1);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes(shape), warnings[0]);
    q.save(loaded, file);
    assert.deepEqual(q.load(file).open, []);
  });
}

const goodItem = (key) => ({ key, id: key, rule: 'r', hitIds: [], seen_days: [], examples: [], hits: 1 });
const shapeDir = (content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hak-shape-'));
  const file = path.join(dir, 'queue.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return { dir, file };
};

for (const [name, content] of [
  ['open is an object', { open: {} }],
  ['open is a string', { open: 'x' }],
  ['resolved is null', { open: [], resolved: null }],
  ['dismissed is a number', { open: [], dismissed: 3 }],
]) {
  test(`C2-4: a queue where ${name} is moved aside and the queue starts empty`, () => {
    const { dir, file } = shapeDir(content);
    const warnings = [];
    const loaded = q.load(file, (w) => warnings.push(w));
    assert.deepEqual([loaded.open, loaded.resolved, loaded.expired, loaded.dismissed], [[], [], [], []]);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('queue.json.corrupt-')).length, 1);
    assert.equal(warnings.length, 1);
    assert.doesNotThrow(() => q.upsert(loaded, []));
  });
}

test('C2-4: one malformed open item among good ones is dropped alone, the file stays, and upsert works', () => {
  const bad = [{ key: 'no-hit-ids' }, { key: 42, hitIds: [], seen_days: [], examples: [] }, 'text', null, [], { hitIds: [], seen_days: [], examples: [] }];
  const { dir, file } = shapeDir({ open: [goodItem('a'), ...bad, goodItem('b')], resolved: [{ key: 'r1' }, 5] });
  const warnings = [];
  const loaded = q.load(file, (w) => warnings.push(w));
  assert.deepEqual(loaded.open.map((i) => i.key), ['a', 'b']);
  assert.deepEqual(loaded.resolved.map((i) => i.key), ['r1']);
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('corrupt')), []);
  assert.deepEqual(warnings, ['queue.json: dropped 7 malformed item(s)']);
  assert.doesNotThrow(() => q.upsert(loaded, [{ rule: 'r', severity: 'low', key: 'c', session: 's', line: 1, ts: '2026-11-20T12:00:00', hook: null, summary: 's', evidence: [] }]));
});

test('C2-4: a well-formed queue loads without a warning', () => {
  const { file } = shapeDir({ version: 1, open: [goodItem('a')], resolved: [], expired: [], dismissed: [{ key: 'd', reason: 'x' }] });
  const warnings = [];
  assert.equal(q.load(file, (w) => warnings.push(w)).open.length, 1);
  assert.deepEqual(warnings, []);
});
