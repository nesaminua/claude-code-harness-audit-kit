'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluate, summary, AUDIT_LEVEL_RULES } = require('../scripts/lib/efficacy');

const K = 'rule-a';
const row = (date, key = K, extra = {}) => ({ key, rule: 'r-' + key, date, resolved_at: date + 'T10:00:00Z', note: 'n', ...extra });
const day = (d) => `2026-11-${String(d).padStart(2, '0')}`;

function reports(spec, key = K) {
  const out = {};
  for (const [d, [hitSessions, exposedSessions]] of Object.entries(spec)) {
    out[day(Number(d))] = { [key]: { hitSessions, exposedSessions } };
  }
  return out;
}

const run = (fixDay, spec, rows) => evaluate(rows || [row(day(fixDay))], reports(spec))[0];

test('regression: before 1, after 10 with exposure 10 is ineffective', () => {
  const r = run(10, { 8: [1, 10], 9: [0, 0], 11: [4, 4], 12: [3, 3], 13: [3, 3] });
  assert.equal(r.verdict, 'ineffective');
  assert.equal(r.before.hits, 1);
  assert.equal(r.after.hits, 10);
  assert.equal(r.after.exposed, 10);
});

test('no hits after with enough exposure is effective', () => {
  const r = run(10, { 8: [3, 5], 9: [2, 5], 11: [0, 2], 12: [0, 2], 13: [0, 2] });
  assert.equal(r.verdict, 'effective');
  assert.equal(r.before.hits, 5);
  assert.equal(r.after.hits, 0);
});

test('rate halved or better is reduced', () => {
  const r = run(10, { 8: [6, 10], 11: [1, 4], 12: [1, 3], 13: [0, 3] });
  assert.equal(r.verdict, 'reduced');
  assert.equal(r.before.rate, 0.6);
  assert.equal(r.after.rate, 0.2);
});

test('rate above half of before is ineffective', () => {
  const r = run(10, { 8: [6, 10], 11: [3, 4], 12: [2, 3], 13: [0, 3] });
  assert.equal(r.verdict, 'ineffective');
});

test('fewer than 3 audited days after is pending', () => {
  const r = run(10, { 8: [5, 5], 11: [0, 5], 12: [0, 5] });
  assert.equal(r.verdict, 'pending');
  assert.equal(r.after.days, 2);
});

test('both windows under 3 hits is insufficient', () => {
  const r = run(10, { 8: [2, 5], 11: [1, 5], 12: [0, 5], 13: [0, 5] });
  assert.equal(r.verdict, 'insufficient');
});

test('after exposure under 3 is insufficient', () => {
  const r = run(10, { 8: [5, 5], 11: [0, 1], 12: [0, 1], 13: [0, 0] });
  assert.equal(r.verdict, 'insufficient');
  assert.equal(r.after.exposed, 2);
});

test('hits on the fix day are excluded', () => {
  const r = run(10, { 8: [4, 5], 10: [9, 9], 11: [0, 3], 12: [0, 3], 13: [0, 3] });
  assert.equal(r.before.hits, 4);
  assert.equal(r.after.hits, 0);
  assert.equal(r.verdict, 'effective');
});

test('a day present without the key counts as 0 hits and 0 exposed but is a day', () => {
  const rep = reports({ 8: [4, 5], 11: [0, 3], 13: [0, 3] });
  rep[day(12)] = { other: { hitSessions: 9, exposedSessions: 9 } };
  const r = evaluate([row(day(10))], rep)[0];
  assert.equal(r.after.days, 3);
  assert.equal(r.after.exposed, 6);
  assert.equal(r.verdict, 'effective');
});

test('windows are capped at 7 audited days each side', () => {
  const spec = {};
  for (let d = 1; d <= 9; d++) spec[d] = [1, 1];
  for (let d = 11; d <= 20; d++) spec[d] = [0, 1];
  const r = run(10, spec);
  assert.equal(r.before.days, 7);
  assert.equal(r.before.hits, 7);
  assert.equal(r.after.days, 7);
  assert.equal(r.after.exposed, 7);
});

test('two fixes on one key: the after window stops at the second fix', () => {
  const spec = { 8: [4, 5], 11: [0, 3], 12: [0, 3], 13: [0, 3], 15: [5, 5], 16: [5, 5], 17: [5, 5] };
  const rows = [row(day(10)), row(day(14))];
  const [second, first] = evaluate(rows, reports(spec));
  assert.equal(first.date, day(10));
  assert.equal(first.after.days, 3);
  assert.equal(first.after.hits, 0);
  assert.equal(first.verdict, 'effective');
  assert.equal(second.date, day(14));
  assert.equal(second.after.hits, 15);
  assert.equal(second.verdict, 'ineffective');
});

test('a later fix on another key does not cut the window', () => {
  const rep = reports({ 8: [4, 5], 11: [0, 3], 12: [0, 3], 13: [0, 3], 15: [0, 3] });
  const r = evaluate([row(day(10), 'other'), row(day(10))], rep).find((x) => x.key === K);
  assert.equal(r.after.days, 4);
});

test('results sort by date descending and carry row fields', () => {
  const rows = [row(day(5)), row(day(20), 'k2', { note: 'later' }), row(day(12), 'k3')];
  const out = evaluate(rows, {});
  assert.deepEqual(out.map((r) => r.date), [day(20), day(12), day(5)]);
  assert.equal(out[0].key, 'k2');
  assert.equal(out[0].rule, 'r-k2');
  assert.equal(out[0].note, 'later');
  assert.equal(out[0].verdict, 'pending');
  assert.deepEqual(out[0].before, { days: 0, hits: 0, exposed: 0, rate: 0 });
});

test('evaluate does not mutate its inputs', () => {
  const rows = [row(day(12)), row(day(10))];
  const rep = reports({ 8: [1, 1] });
  const before = JSON.stringify([rows, rep]);
  evaluate(rows, rep);
  assert.equal(JSON.stringify([rows, rep]), before);
});

test('summary counts each verdict', () => {
  const out = [{ verdict: 'effective' }, { verdict: 'effective' }, { verdict: 'reduced' }, { verdict: 'pending' }, { verdict: 'insufficient' }, { verdict: 'ineffective' }];
  assert.deepEqual(summary(out), { tracked: 6, effective: 2, reduced: 1, ineffective: 1, insufficient: 1, pending: 1, na: 0 });
  assert.deepEqual(summary([]), { tracked: 0, effective: 0, reduced: 0, ineffective: 0, insufficient: 0, pending: 0, na: 0 });
});

test('a resolved audit-level row has no session exposure: n/a, measured by the trend itself', () => {
  const days = { '2026-01-05': {}, '2026-01-06': {}, '2026-01-08': {}, '2026-01-09': {}, '2026-01-10': {} };
  for (const rule of ['outcome-regression', 'outcome-shift', 'claude-version-changed']) {
    const [r] = evaluate([{ key: `${rule}:blocks`, rule, date: '2026-01-07', note: 'n' }], days);
    assert.equal(r.verdict, 'n/a', rule);
    assert.equal(r.reason, 'measured by the trend itself');
    assert.equal(r.rule, rule);
  }
});

test('summary counts n/a rows under na and keeps them in tracked', () => {
  const out = [{ verdict: 'n/a' }, { verdict: 'n/a' }, { verdict: 'effective' }];
  const s = summary(out);
  assert.equal(s.na, 2);
  assert.equal(s.tracked, 3);
  assert.equal(s.effective, 1);
});

test('AUDIT_LEVEL_RULES names exactly the three rules the audit derives from trends', () => {
  assert.deepEqual([...AUDIT_LEVEL_RULES].sort(), ['claude-version-changed', 'outcome-regression', 'outcome-shift']);
});
