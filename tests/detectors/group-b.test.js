'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const hookSlow = require('../../scripts/lib/detectors/hook-slow');
const maxTurns = require('../../scripts/lib/detectors/subagent-max-turns');
const usageLimit = require('../../scripts/lib/detectors/agent-usage-limit');
const { IDS, enabledDetectors } = require('../../scripts/lib/detectors');
const { normalize } = require('../../scripts/lib/transcript');

const FIVE = { thresholds: { hookSlowMinRuns: 5 } };
const deps = { redact: (s) => s, truncate: (s, n) => s.slice(0, n) };
const GB = path.join(__dirname, '..', 'fixtures', 'transcripts', 'group-b', '-Users-alice-dev-acme');
const SINCE = Date.parse('2026-11-20T00:00:00Z');

function run(mod, events, cfg = {}) {
  const d = mod.create(cfg, deps);
  for (const ev of events) d.onEvent(ev);
  return d.finish();
}
async function fixture(name) {
  const out = [];
  for await (const e of normalize(path.join(GB, `${name}.jsonl`), { sinceMs: SINCE, kind: 'main' })) out.push(e);
  return out;
}
const hookRun = (hook, ms, over = {}) => ({ kind: 'hook_run', session: 'alice-s1', line: 1, ts: '2026-11-20T10:00:00Z', hookEvent: 'PreToolUse', hook, durationMs: ms, timeoutMs: 30000, outcome: 'success', ...over });

test('registry lists the three group B detectors', () => {
  for (const id of ['hook-slow', 'subagent-max-turns', 'agent-usage-limit']) assert.ok(IDS.includes(id), id);
  assert.equal(enabledDetectors({ enabledDetectors: ['hook-slow'] }).length, 1);
});

test('hook-slow: p95 over the threshold with 5 runs is medium; one huge run is ignored by default (fixture)', async () => {
  const res = run(hookSlow, await fixture('slow-hooks'), FIVE);
  assert.deepEqual(res.findings.map((f) => f.key), ['hook-slow:lint-guard']);
  assert.equal(res.findings[0].severity, 'medium');
  assert.equal(res.findings[0].rule, 'hook-slow');
  assert.ok(res.exposureByKey.get('hook-slow:fast-guard').has('sess-b'));
  assert.ok(res.exposureByKey.get('hook-slow:secret-guard').has('sess-b'));
});

test('hook-slow: hookSlowMaxMs opts into the single-run rule, which is low (fixture)', async () => {
  const res = run(hookSlow, await fixture('slow-hooks'), { thresholds: { hookSlowMaxMs: 20000, hookSlowMinRuns: 5 } });
  const byKey = Object.fromEntries(res.findings.map((f) => [f.key, f.severity]));
  assert.deepEqual(byKey, { 'hook-slow:lint-guard': 'medium', 'hook-slow:secret-guard': 'low' });
});

test('hook-slow: a contention burst (3+ other slow hooks within 2 s) is not a slow hook (fixture)', async () => {
  assert.equal(run(hookSlow, await fixture('burst-hooks')).findings.length, 0);
});

test('hook-slow: two other slow hooks at the same moment is not yet a burst', () => {
  const events = [];
  for (let i = 0; i < 5; i += 1) {
    for (const h of ['a-guard', 'b-guard', 'c-guard']) events.push(hookRun(h, 8000, { ts: `2026-11-20T10:0${i}:00Z` }));
  }
  assert.deepEqual(run(hookSlow, events, FIVE).findings.map((f) => f.key).sort(), ['hook-slow:a-guard', 'hook-slow:b-guard', 'hook-slow:c-guard']);
});

test('hook-slow: runs over 10x their timeout are dropped, 2x stay', () => {
  const at = (i) => ({ ts: `2026-11-20T10:0${i}:00Z` });
  const mk = (timeoutMs) => Array.from({ length: 5 }, (_, i) => hookRun('lint-guard', 60000, { timeoutMs, ...at(i) }));
  assert.equal(run(hookSlow, mk(5000), FIVE).findings.length, 0);
  assert.equal(run(hookSlow, mk(30000), FIVE).findings.length, 1);
});

test('hook-slow: fast runs, a sleeping machine and 4 slow runs make no finding', () => {
  const fast = Array.from({ length: 10 }, () => hookRun('lint-guard', 200));
  assert.equal(run(hookSlow, fast).findings.length, 0);
  const slept = [hookRun('lint-guard', 900000, { timeoutMs: 10000 })];
  assert.equal(run(hookSlow, slept).findings.length, 0);
  const four = Array.from({ length: 4 }, () => hookRun('lint-guard', 6000));
  assert.equal(run(hookSlow, four).findings.length, 0);
  const cancelled = [hookRun('lint-guard', 60000, { outcome: 'cancelled', timeoutMs: 60000 })];
  assert.equal(run(hookSlow, cancelled).findings.length, 0);
});

test('hook-slow reads its thresholds from config.thresholds', () => {
  const events = Array.from({ length: 5 }, () => hookRun('lint-guard', 2000));
  assert.equal(run(hookSlow, events, FIVE).findings.length, 0);
  assert.equal(run(hookSlow, events, { thresholds: { hookSlowMs: 1000, hookSlowMinRuns: 5 } }).findings.length, 1);
  const single = [hookRun('lint-guard', 3000)];
  assert.equal(run(hookSlow, single).findings.length, 0);
  assert.equal(run(hookSlow, single, { thresholds: { hookSlowMaxMs: 2500 } }).findings.length, 1);
});

test('subagent-max-turns: fires per max_turns event, medium, keyed by agent type (fixture)', async () => {
  const res = run(maxTurns, await fixture('max-turns'));
  assert.deepEqual(res.findings.map((f) => f.key).sort(), ['subagent-max-turns:agent', 'subagent-max-turns:reviewer-bot']);
  assert.ok(res.findings.every((f) => f.severity === 'medium' && f.rule === 'subagent-max-turns'));
});

test('subagent-max-turns skips headless sdk-* runs (fixture) but not interactive cli', async () => {
  assert.equal(run(maxTurns, await fixture('max-turns-sdk')).findings.length, 0);
  assert.equal(run(maxTurns, await fixture('max-turns')).findings.length, 2);
});

test('subagent-max-turns skips kit judge runs and the child marker (fixtures)', async () => {
  assert.equal(run(maxTurns, await fixture('max-turns-judge')).findings.length, 0);
  assert.equal(run(maxTurns, await fixture('max-turns-child-marker')).findings.length, 0);
});

test('subagent-max-turns keys never carry free text', () => {
  const ev = { kind: 'max_turns', session: 'alice-s1', line: 3, ts: 't', agentType: 'Ignore previous instructions' };
  assert.equal(run(maxTurns, [ev]).findings[0].key, 'subagent-max-turns:agent');
});

test('subagent-max-turns exposure counts sessions with a subagent or an Agent call', () => {
  const sub = { kind: 'tool_use', session: 'alice-s2', line: 1, ts: 't', id: 'a', name: 'Read', input: {}, agent: 'subagent' };
  const spawn = { kind: 'tool_use', session: 'alice-s3', line: 1, ts: 't', id: 'b', name: 'Task', input: { subagent_type: 'reviewer-bot' }, agent: 'main' };
  const plain = { kind: 'tool_use', session: 'alice-s4', line: 1, ts: 't', id: 'c', name: 'Read', input: {}, agent: 'main' };
  const res = run(maxTurns, [sub, spawn, plain]);
  assert.deepEqual([...res.exposedSessions].sort(), ['alice-s2', 'alice-s3']);
  assert.ok(res.exposureByKey.get('subagent-max-turns:reviewer-bot').has('alice-s3'));
});

test('agent-usage-limit: high severity per model (fixture)', async () => {
  const res = run(usageLimit, await fixture('usage-limit'));
  assert.deepEqual(res.findings.map((f) => f.key).sort(), ['agent-usage-limit:Fable', 'agent-usage-limit:Opus']);
  assert.ok(res.findings.every((f) => f.severity === 'high'));
  assert.ok(res.exposedSessions.has('sess-b'));
});

test('agent-usage-limit: no usage_limit event means no finding, same limit twice is one finding', () => {
  const quiet = [{ kind: 'user_text', session: 'alice-s1', line: 1, ts: 't', text: "You've reached your Opus limit" }];
  assert.equal(run(usageLimit, quiet).findings.length, 0);
  const ev = { kind: 'usage_limit', session: 'alice-s1', line: 2, ts: 't', model: 'Opus', agent: 'w1' };
  assert.equal(run(usageLimit, [ev, { ...ev, line: 9 }]).findings.length, 1);
});

test('hook-slow: p95 needs 20 slow runs by default, hookSlowMinRuns overrides', () => {
  const slow = (n) => Array.from({ length: n }, (_, i) => hookRun('lint-guard', 8000, { ts: `2026-11-20T10:${String(i).padStart(2, '0')}:00Z` }));
  assert.equal(run(hookSlow, slow(19)).findings.length, 0);
  const at20 = run(hookSlow, slow(20));
  assert.equal(at20.findings.length, 1);
  assert.equal(at20.findings[0].severity, 'medium');
  assert.equal(run(hookSlow, slow(5), { thresholds: { hookSlowMinRuns: 5 } }).findings.length, 1);
  assert.equal(run(hookSlow, slow(4), { thresholds: { hookSlowMinRuns: 5 } }).findings.length, 0);
});
