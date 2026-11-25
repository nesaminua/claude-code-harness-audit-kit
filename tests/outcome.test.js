'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const outcome = require('../scripts/lib/outcome');

const TODAY = '2026-11-25';
const day = (n) => `2026-11-${String(n).padStart(2, '0')}`;
const stamp = (d, sec = 0) => new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)), 12, 0, sec).toISOString();

const RAW = { sessions: 2, tool_calls: 100, blocks: 2, retries: 0, tool_errors: 2, corrections: 2, interrupts: 2 };

function window(days, over) {
  return Object.fromEntries(days.map((d) => [d, { ...RAW, ...over }]));
}

const BEFORE_DAYS = [11, 12, 13, 14, 15, 16, 17].map(day);
const AFTER_DAYS = [18, 19, 20, 21, 22, 23, 24].map(day);

function metrics(beforeOver = {}, afterOver = {}) {
  return { ...window(BEFORE_DAYS, beforeOver), ...window(AFTER_DAYS, afterOver) };
}

const keys = (list) => list.map((f) => f.key).sort();

test('blocks per 100 calls 2 -> 5 with enough sessions is a medium regression', () => {
  const found = outcome.trend(metrics({ blocks: 2 }, { blocks: 5 }), { today: TODAY });
  assert.deepEqual(keys(found), ['outcome-regression:blocks_per_100_calls']);
  const f = found[0];
  assert.equal(f.rule, 'outcome-regression');
  assert.equal(f.severity, 'medium');
  assert.match(f.summary, /\b2\b.*\b5\b/);
  assert.equal(f.evidence.length, 2);
  assert.match(f.evidence[0], /2026-11-11/);
  assert.match(f.evidence[1], /2026-11-24/);
  assert.equal(new Date(f.ts).getDate(), 24);
});

test('the same values with too few sessions give no finding', () => {
  const few = metrics({ blocks: 2, sessions: 1 }, { blocks: 5, sessions: 1 });
  assert.deepEqual(outcome.trend(few, { today: TODAY }), []);
});

test('minSessions is read from config.outcome with a fallback of 10', () => {
  const few = metrics({ blocks: 2, sessions: 1 }, { blocks: 5, sessions: 1 });
  assert.equal(outcome.trend(few, { today: TODAY, config: { outcome: { minSessions: 7 } } }).length, 1);
  assert.deepEqual(outcome.trend(few, { today: TODAY, config: { outcome: {} } }), []);
});

test('regressionPct is read from config.outcome with a fallback of 30', () => {
  const m = metrics({ blocks: 10 }, { blocks: 12 });
  assert.deepEqual(outcome.trend(m, { today: TODAY }), []);
  assert.equal(outcome.trend(m, { today: TODAY, config: { outcome: { regressionPct: 20 } } }).length, 1);
});

test('exactly the regression threshold counts', () => {
  assert.equal(outcome.trend(metrics({ blocks: 10 }, { blocks: 13 }), { today: TODAY }).length, 1);
  assert.deepEqual(outcome.trend(metrics({ blocks: 10 }, { blocks: 12 }), { today: TODAY }), []);
});

test('an improvement is never a finding', () => {
  assert.deepEqual(outcome.trend(metrics({ blocks: 5, tool_errors: 9 }, { blocks: 2, tool_errors: 2 }), { today: TODAY }), []);
});

test('every harness cost metric can regress', () => {
  const cases = {
    retries: ['outcome-regression:retry_after_block_rate', { blocks: 5, retries: 1 }, { blocks: 5, retries: 4 }],
    tool_errors: ['outcome-regression:tool_errors_per_session', { tool_errors: 2 }, { tool_errors: 6 }],
    corrections: ['outcome-regression:corrections_per_session', { corrections: 2 }, { corrections: 6 }],
    interrupts: ['outcome-regression:interrupts_per_session', { interrupts: 2 }, { interrupts: 6 }],
  };
  for (const [name, [key, before, after]] of Object.entries(cases)) {
    assert.deepEqual(keys(outcome.trend(metrics(before, after), { today: TODAY })), [key], name);
  }
});

test('a rise from zero needs at least 3 events in the later window', () => {
  assert.deepEqual(outcome.trend(metrics({ corrections: 0 }, { corrections: 0 }), { today: TODAY }), []);
  const small = { ...metrics({ corrections: 0 }, { corrections: 0 }), [day(24)]: { ...RAW, corrections: 2 } };
  assert.deepEqual(outcome.trend(small, { today: TODAY }), []);
  const found = outcome.trend(metrics({ corrections: 0 }, { corrections: 1 }), { today: TODAY });
  assert.deepEqual(keys(found), ['outcome-regression:corrections_per_session']);
});

test('tool calls per session shifting by 50% either way is a low outcome-shift', () => {
  const up = outcome.trend(metrics({ tool_calls: 100 }, { tool_calls: 200 }), { today: TODAY });
  assert.deepEqual(keys(up), ['outcome-shift:tool_calls_per_session']);
  assert.equal(up[0].rule, 'outcome-shift');
  assert.equal(up[0].severity, 'low');
  const down = outcome.trend(metrics({ tool_calls: 200, blocks: 4 }, { tool_calls: 100, blocks: 2 }), { today: TODAY });
  assert.deepEqual(keys(down), ['outcome-shift:tool_calls_per_session']);
  assert.deepEqual(outcome.trend(metrics({ tool_calls: 100 }, { tool_calls: 140 }), { today: TODAY }), []);
});

test('only the last 7 audited days and the 7 before count, today is left out', () => {
  const m = {
    ...metrics({ blocks: 2 }, { blocks: 2 }),
    [day(5)]: { ...RAW, blocks: 90 },
    [TODAY]: { ...RAW, blocks: 90 },
  };
  assert.deepEqual(outcome.trend(m, { today: TODAY }), []);
});

test('days without sessions do not take a place in a window', () => {
  const gaps = metrics({ blocks: 2 }, { blocks: 5 });
  for (const d of ['2026-11-19', '2026-11-20']) gaps[d] = { sessions: 0, tool_calls: 0, blocks: 0, retries: 0, tool_errors: 0, corrections: 0, interrupts: 0 };
  assert.deepEqual(keys(outcome.trend(gaps, { today: TODAY })), ['outcome-regression:blocks_per_100_calls']);
});

test('no earlier window means no finding', () => {
  assert.deepEqual(outcome.trend(window(AFTER_DAYS, { blocks: 9 }), { today: TODAY }), []);
  assert.deepEqual(outcome.trend({}, { today: TODAY }), []);
  assert.deepEqual(outcome.trend(undefined, { today: TODAY }), []);
});

test('entries without raw counts are ignored, not fatal', () => {
  const m = { ...metrics(), [day(10)]: { note: 'old' }, [day(9)]: null };
  assert.doesNotThrow(() => outcome.trend(m, { today: TODAY }));
});

test('compare gives both windows with rates for the status table', () => {
  const cmp = outcome.compare(metrics({ blocks: 2 }, { blocks: 5 }), { today: TODAY });
  assert.equal(cmp.before.sessions, 14);
  assert.equal(cmp.after.sessions, 14);
  assert.equal(cmp.before.rates.blocks_per_100_calls, 2);
  assert.equal(cmp.after.rates.blocks_per_100_calls, 5);
  assert.equal(cmp.after.rates.tool_calls_per_session, 50);
  assert.equal(outcome.compare({}, { today: TODAY }), null);
  assert.equal(outcome.compare(window(AFTER_DAYS, {}), { today: TODAY }), null);
});

function ev(kind, d, sec, session, extra = {}) {
  return { kind, session, ts: stamp(d, sec), ...extra };
}

test('collector builds per-day metrics from normalized events', () => {
  const c = outcome.collector();
  const d = day(20);
  for (const e of [
    ev('tool_use', d, 0, 's1', { id: 'a', inputHash: 'h1' }),
    ev('block', d, 1, 's1', { toolUseId: 'a' }),
    ev('tool_use', d, 2, 's1', { id: 'b', inputHash: 'h1' }),
    ev('tool_use', d, 3, 's1', { id: 'c', inputHash: 'h2' }),
    ev('tool_result', d, 4, 's1', { toolUseId: 'c', isError: true }),
    ev('tool_result', d, 5, 's1', { toolUseId: 'b', isError: false }),
    ev('tool_use', d, 0, 's2', { id: 'x', inputHash: 'h9' }),
    ev('user_text', d, 1, 's2', { text: 'hello' }),
  ]) c.onEvent(e);
  c.addFindings([
    { rule: 'user-correction', ts: stamp(d, 6) },
    { rule: 'user-interrupt', ts: stamp(d, 7) },
    { rule: 'user-interrupt', ts: stamp(d, 8) },
    { rule: 'block-loop', ts: stamp(d, 9) },
  ]);
  const m = c.metrics()[d];
  assert.equal(m.sessions, 2);
  assert.equal(m.tool_calls, 4);
  assert.equal(m.blocks, 1);
  assert.equal(m.retries, 1);
  assert.equal(m.tool_errors, 1);
  assert.equal(m.corrections, 1);
  assert.equal(m.interrupts, 2);
  assert.equal(m.tool_calls_per_session, 2);
  assert.equal(m.blocks_per_100_calls, 25);
  assert.equal(m.retry_after_block_rate, 1);
  assert.equal(m.tool_errors_per_session, 0.5);
  assert.equal(m.corrections_per_session, 0.5);
  assert.equal(m.interrupts_per_session, 1);
});

test('a retry needs the same call within 3 calls after the block, in the same session', () => {
  const c = outcome.collector();
  const d = day(20);
  const seq = [
    ev('tool_use', d, 0, 's1', { id: 'a', inputHash: 'h1' }),
    ev('block', d, 1, 's1', { toolUseId: 'a' }),
    ev('tool_use', d, 2, 's1', { id: 'b', inputHash: 'h2' }),
    ev('tool_use', d, 3, 's2', { id: 'o', inputHash: 'h1' }),
    ev('tool_use', d, 4, 's1', { id: 'c', inputHash: 'h3' }),
    ev('tool_use', d, 5, 's1', { id: 'd', inputHash: 'h4' }),
    ev('tool_use', d, 6, 's1', { id: 'e', inputHash: 'h1' }),
  ];
  seq.forEach((e) => c.onEvent(e));
  assert.equal(c.metrics()[d].retries, 0);
});

test('events are bucketed by local day and a day without a session id is not counted as a session', () => {
  const c = outcome.collector();
  c.onEvent(ev('tool_use', day(20), 0, 's1', { id: 'a', inputHash: 'h' }));
  c.onEvent(ev('tool_use', day(21), 0, 's1', { id: 'b', inputHash: 'h' }));
  c.onEvent({ kind: 'tool_use', ts: stamp(day(21), 3), id: 'z', inputHash: 'q' });
  c.onEvent({ kind: 'tool_use', ts: 'not a date', session: 's1', id: 'y', inputHash: 'q' });
  const m = c.metrics();
  assert.deepEqual(Object.keys(m).sort(), [day(20), day(21)]);
  assert.equal(m[day(21)].sessions, 1);
});

test('collector keeps the newest valid version', () => {
  const c = outcome.collector();
  c.onEvent(ev('tool_use', day(20), 5, 's1', { id: 'a', inputHash: 'h', version: '2.1.301' }));
  c.onEvent(ev('tool_use', day(20), 1, 's1', { id: 'b', inputHash: 'h', version: '2.1.300' }));
  c.onEvent(ev('tool_use', day(20), 9, 's1', { id: 'c', inputHash: 'h', version: 'not a version; rm -rf' }));
  const latest = c.latestVersion();
  assert.equal(latest.version, '2.1.301');
  assert.equal(latest.ts, stamp(day(20), 5));
  assert.equal(outcome.collector().latestVersion(), null);
});

test('versionChange: first sight records, a change finds once, the same version is quiet', () => {
  const at = (v, sec) => ({ version: v, ts: stamp(day(20), sec) });
  const first = outcome.versionChange({}, at('2.1.300', 1));
  assert.equal(first.finding, null);
  assert.deepEqual(first.next, { last_version: '2.1.300', last_version_at: at('2.1.300', 1).ts });

  const changed = outcome.versionChange(first.next, at('2.1.301', 2));
  assert.equal(changed.finding.key, 'claude-version-changed:2.1.301');
  assert.equal(changed.finding.rule, 'claude-version-changed');
  assert.equal(changed.finding.severity, 'low');
  assert.equal(changed.finding.summary, 'CLI version 2.1.300 → 2.1.301: re-run your hook tests');
  assert.equal(changed.next.last_version, '2.1.301');

  const same = outcome.versionChange(changed.next, at('2.1.301', 3));
  assert.equal(same.finding, null);
});

test('versionChange ignores an older sighting, a missing version and a junk version', () => {
  const state = { last_version: '2.1.301', last_version_at: stamp(day(20), 5) };
  assert.equal(outcome.versionChange(state, { version: '2.1.300', ts: stamp(day(19), 0) }).finding, null);
  assert.equal(outcome.versionChange(state, { version: '2.1.300', ts: stamp(day(19), 0) }).next, null);
  assert.deepEqual(outcome.versionChange(state, null), { finding: null, next: null });
  assert.deepEqual(outcome.versionChange(state, { version: '<script>', ts: stamp(day(21), 0) }), { finding: null, next: null });
});
