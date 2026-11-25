'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const toolErrorLoop = require('../../scripts/lib/detectors/tool-error-loop');
const hookError = require('../../scripts/lib/detectors/hook-error');

const deps = { redact: (s) => s, truncate: (s, n) => s.slice(0, n) };
const S = 'alice-session-1';

let seq = 0;
const use = (over = {}) => {
  seq += 1;
  return { kind: 'tool_use', session: S, line: seq, ts: 't', id: `tu${seq}`, name: 'Bash',
    input: {}, messageId: `m${seq}`, ...over };
};
const result = (tu, text, over = {}) => ({ kind: 'tool_result', session: S, line: tu.line + 0.5,
  ts: 't', toolUseId: tu.id, isError: true, text, ...over });

function run(mod, events, cfg = {}) {
  const d = mod.create(cfg, deps);
  for (const ev of events) d.onEvent(ev);
  return d.finish();
}

function errors(texts, useOver = () => ({})) {
  return texts.flatMap((text, i) => {
    const tu = use(useOver(i));
    return [tu, result(tu, text)];
  });
}

const vitest = (ms) => `Exit code 1\n RUN  v2.1.0 /work\n\n FAIL  tests/a.test.js:12 > suite > case (${ms}ms)\nAssertionError: expected 1 to be 2`;

test('the same vitest failure 3x with different durations is one finding', () => {
  const res = run(toolErrorLoop, errors([vitest(110), vitest(2300), vitest(45)]));
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].rule, 'tool-error-loop');
  assert.equal(res.findings[0].severity, 'medium');
  assert.equal(res.findings[0].key, 'tool-error-loop:Bash');
});

test('different file:line values make no finding', () => {
  const texts = [12, 40, 77].map((n) => `FAIL tests/a.test.js:${n} > case`);
  assert.equal(run(toolErrorLoop, errors(texts)).findings.length, 0);
});

test('user rejections are excluded', () => {
  const texts = ["The user doesn't want to proceed with this tool use.", 'User rejected the call',
    "The user doesn't want to proceed with this tool use.", 'User rejected the call'];
  const res = run(toolErrorLoop, errors(texts));
  assert.equal(res.findings.length, 0);
  assert.equal(res.exposedSessions.size, 0);
});

test('errors from one messageId batch count once', () => {
  const res = run(toolErrorLoop, errors([vitest(1), vitest(2), vitest(3)], () => ({ messageId: 'batch' })));
  assert.equal(res.findings.length, 0);
});

test('non-error results are ignored', () => {
  const tu = use();
  const res = run(toolErrorLoop, [tu, result(tu, vitest(1), { isError: false })]);
  assert.equal(res.exposedSessions.size, 0);
});

test('frames are skipped when building the signature', () => {
  const texts = ['Exit code 2\n> build\ncurl: (22) The requested URL returned error: 500\nError: boom 1',
    'Exit code 7\n> build\ncurl: (22) The requested URL returned error: 500\nError: boom 2',
    'Exit code 9\n> build\ncurl: (22) The requested URL returned error: 500\nError: boom 3'];
  assert.equal(run(toolErrorLoop, errors(texts)).findings.length, 1);
});

test('threshold comes from config and emits once per signature', () => {
  const texts = Array.from({ length: 5 }, () => 'Error: same');
  assert.equal(run(toolErrorLoop, errors(texts.slice(0, 2)), { thresholds: { toolErrorLoop: 2 } }).findings.length, 1);
  assert.equal(run(toolErrorLoop, errors(texts)).findings.length, 1);
});

test('signature is capped at 240 characters', () => {
  assert.ok(toolErrorLoop.errorSignature(`Error: ${'x'.repeat(500)}`).length <= 240);
  const res = run(toolErrorLoop, errors(Array.from({ length: 3 }, () => `Error: ${'x'.repeat(500)}`)));
  assert.equal(res.findings.length, 1);
});

test('tool-error-loop exposure maps are filled', () => {
  const res = run(toolErrorLoop, errors(['Error: a']));
  assert.ok(res.exposedSessions.has(S));
  assert.ok(res.exposureByKey.get('tool-error-loop:Bash').has(S));
});

const hookEv = (type, over = {}) => ({ kind: 'hook_error', session: S, line: 1, ts: 't',
  hookEvent: 'PreToolUse', hook: '/home/alice/hooks/lint-guard.js', type, detail: 'TypeError: x is not a function\n  at y', ...over });

test('a crash gets severity high and the documented summary', () => {
  const res = run(hookError, [hookEv('crash')]);
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].severity, 'high');
  assert.equal(res.findings[0].key, 'hook-error:lint-guard');
  assert.equal(res.findings[0].summary, 'PreToolUse /home/alice/hooks/lint-guard.js: crash — TypeError: x is not a function');
});

test('timeout and non_blocking get severity medium', () => {
  const res = run(hookError, [hookEv('timeout'), hookEv('non_blocking')]);
  assert.deepEqual(res.findings.map((f) => f.severity), ['medium', 'medium']);
});

const runEv = (session, hook = '/home/alice/hooks/lint-guard.js') => ({ kind: 'hook_run', session, line: 1, ts: 't', hookEvent: 'PreToolUse', hook });

test('hook-error exposure is the sessions where that hook ran', () => {
  const events = [runEv('bob-session-2'), runEv('carol-session-3'), runEv('dave-session-4', '/x/other-hook.js'),
    { kind: 'tool_use', session: 'erin-session-5', id: 'x', name: 'Bash' }, hookEv('crash')];
  const res = run(hookError, events);
  const set = res.exposureByKey.get('hook-error:lint-guard');
  assert.deepEqual([...set].sort(), [S, 'bob-session-2', 'carol-session-3'].sort());
  assert.ok(!set.has('dave-session-4') && !set.has('erin-session-5'));
  assert.deepEqual([...res.exposureByKey.get('hook-error:other-hook')], ['dave-session-4']);
});

test('a hook that ran clean everywhere still has exposure but no finding', () => {
  const res = run(hookError, [runEv('bob-session-2')]);
  assert.equal(res.findings.length, 0);
  assert.ok(res.exposureByKey.get('hook-error:lint-guard').has('bob-session-2'));
});

const TOKEN = `sk-${'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3Ab4Cd5Ef6Gh7Ij8'}`;
const leaks = (text, token = TOKEN) => {
  for (let i = 0; i + 12 <= token.length; i += 1) if (text.includes(token.slice(i, i + 12))) return true;
  return false;
};

test('F3: a token inside the error line, with digits, never reaches summary or evidence', () => {
  const d = toolErrorLoop.create({});
  for (let i = 0; i < 3; i += 1) {
    const tu = use();
    d.onEvent(tu);
    d.onEvent(result(tu, `Error: request failed for ${TOKEN} at attempt ${i}`));
  }
  const [f] = d.finish().findings;
  assert.ok(f);
  assert.equal(leaks(JSON.stringify(f)), false);
});

test('F3: the grouping signature still masks digits', () => {
  assert.equal(toolErrorLoop.errorSignature('Error: took 120 ms'), 'Error: took # ms');
});

test('F4: a 200 KB adversarial error text gives a signature in under 300 ms', () => {
  for (const body of ['a.'.repeat(100000), 'a'.repeat(200000), 'a-b_'.repeat(50000)]) {
    const started = process.hrtime.bigint();
    const sig = toolErrorLoop.errorSignature(`Error: ${body}`);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 300, `took ${ms} ms`);
    assert.ok(sig.length <= 240);
  }
});
