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

// Fictional runner outputs: `same(i)` is one failure repeated with volatile parts, `other(i)` three different failures.
const WORDS = ['alpha', 'beta', 'gamma'];
const RUNNERS = {
  pytest: {
    same: (i) => `Exit code 1\n${'='.repeat(35)} FAILURES ${'='.repeat(35)}\n${'_'.repeat(10)} test_alpha ${'_'.repeat(10)}\n\n>   assert total == 1\nE   AssertionError: assert 2 == 1\n\ntests/test_a.py:${12 + i}: AssertionError\n${'='.repeat(10)} short test summary info ${'='.repeat(10)}\nFAILED tests/test_a.py::test_alpha - AssertionError\n${'='.repeat(10)} 1 failed in 0.${i}2s ${'='.repeat(10)}`,
    other: (i) => `Exit code 1\n${'='.repeat(35)} FAILURES ${'='.repeat(35)}\n${'_'.repeat(10)} test_${WORDS[i]} ${'_'.repeat(10)}\n\nE   KeyError: '${WORDS[i]}'\n\nFAILED tests/test_a.py::test_${WORDS[i]} - KeyError\n`,
  },
  vitest: {
    same: (i) => `Exit code 1\n RUN  v2.1.0 /work/app\n\n ❯ src/a.test.ts (1 test | 1 failed) ${i}ms\n   × suite > case\n\n FAIL  src/a.test.ts > suite > case\nAssertionError: expected 1 to be 2\n Duration ${i}.2s`,
    other: (i) => `Exit code 1\n RUN  v2.1.0 /work/app\n ❯ src/a.test.ts (1 test | 1 failed)\n   × suite > ${WORDS[i]}\n\n FAIL  src/a.test.ts > suite > ${WORDS[i]}\nAssertionError: expected 1 to be 2`,
  },
  'node:test': {
    same: (i) => `Exit code 1\n✔ first row (0.${i}ms)\n✖ alpha works (1.${i}ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal\nℹ tests 3\nℹ fail 1\n✖ failing tests:\n`,
    other: (i) => `Exit code 1\n✔ first row (0.1ms)\n✖ ${WORDS[i]} works (1.1ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal\nℹ fail 1\n`,
  },
  jest: {
    same: (i) => `Exit code 1\nFAIL src/a.test.js\n  ● suite › case\n\n    expect(received).toBe(expected)\n\nTime: ${i}.4 s`,
    other: (i) => `Exit code 1\nFAIL src/a.test.js\n  ● suite › ${WORDS[i]}\n\n    expect(received).toBe(expected)\n`,
  },
  cargo: {
    same: (i) => `error[E0308]: mismatched types\n --> src/main.rs:${40 + i}:5\nerror: could not compile \`app\` (bin "app") due to 1 previous error`,
    other: (i) => `error[E0${400 + i * 25}]: cannot find value \`${WORDS[i]}\` in this scope\n --> src/main.rs:4:5\n`,
  },
  tsc: {
    same: (i) => `Exit code 2\nsrc/a.ts(${10 + i},5): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error in src/a.ts:${10 + i}`,
    other: (i) => `Exit code 2\nsrc/a.ts(10,5): error TS2322: Type '${WORDS[i]}' is not assignable to type 'number'.\n`,
  },
  'npm ERR!': {
    same: (i) => `Exit code 1\nnpm ERR! code ELIFECYCLE\nnpm ERR! errno 1\nnpm ERR! app@1.0.${i} test: \`vitest\`\nnpm ERR! A complete log of this run can be found in: /tmp/npm-${i}${i}${i}${i}/debug.log`,
    other: (i) => `Exit code 1\nnpm ERR! code E${WORDS[i].toUpperCase()}\nnpm ERR! errno 1\n`,
  },
  MCP: {
    same: (i) => `No element found with reference: "ref_${i}${i}". The element may have been removed from the page.`,
    other: (i) => ['No element found with reference: "ref_1".', 'Navigation timed out waiting for the tab.', 'Tab is not available.'][i],
  },
};

for (const [name, text] of Object.entries(RUNNERS)) {
  test(`${name}: the same failure 3x with volatile parts is one finding`, () => {
    const res = run(toolErrorLoop, errors([0, 1, 2].map(text.same)));
    assert.equal(res.findings.length, 1);
    assert.ok(toolErrorLoop.errorSignature(text.same(0)).length > 0);
  });

  test(`${name}: three different failures under one banner are no loop`, () => {
    assert.equal(run(toolErrorLoop, errors([0, 1, 2].map(text.other))).findings.length, 0);
  });
}

const sigOf = toolErrorLoop.errorSignature;

test('a banner, separator or summary header is never the signature', () => {
  assert.equal(sigOf(`${'='.repeat(30)} FAILURES ${'='.repeat(30)}\n${'_'.repeat(10)} test_x ${'_'.repeat(10)}`), null);
  assert.equal(sigOf(`⎯⎯⎯ Failed Tests 1 ⎯⎯⎯`), null);
  assert.equal(sigOf('=====================\n'), null);
  assert.equal(sigOf('✖ 3 problems (3 errors, 0 warnings)'), null);
  assert.equal(sigOf('✖ failing tests:\n'), null);
});

test('a passing row is never the signature, even when its name holds Error', () => {
  assert.equal(sigOf('✔ lineError: measure lines carry no SKU (1.2ms)\nℹ fail 0'), null);
  assert.equal(sigOf('✔ ok one\n✖ real failure name (1ms)'), '✖ real failure name (#ms)');
  const res = run(toolErrorLoop, errors(Array.from({ length: 3 }, () => '✔ lineError: measure lines carry no SKU (1.2ms)')));
  assert.equal(res.findings.length, 0);
});

test('text without any error-like line has no signature and is never counted', () => {
  for (const text of ['backup tag: abc1234', 'Exit code 1', '', '   \n  ', 'done']) assert.equal(sigOf(text), null, JSON.stringify(text));
  const res = run(toolErrorLoop, errors(Array.from({ length: 5 }, () => 'backup tag: abc1234')));
  assert.equal(res.findings.length, 0);
  assert.ok(res.exposedSessions.has(S));
});

test('volatile parts collapse: durations, ports, hex ids, tmp paths', () => {
  const a = sigOf('Error: connect failed http://localhost:3011 at /tmp/run-1a2b3c4d/x.log (12.5ms) id 9f8e7d6c5b4a');
  const b = sigOf('Error: connect failed http://localhost:4022 at /tmp/run-77aa88bb/x.log (907.1ms) id 0a1b2c3d4e5f');
  assert.equal(a, b);
});

test('a python traceback is named by its exception line, not by its first line', () => {
  const tb = (mod) => `Exit code 1\nTraceback (most recent call last):\n  File "/tmp/x.py", line 3, in <module>\nModuleNotFoundError: No module named '${mod}'`;
  assert.equal(sigOf(tb('fitz')), "ModuleNotFoundError: No module named 'fitz'");
  assert.notEqual(sigOf(tb('fitz')), sigOf(tb('numpy')));
});

test('a tool refusal without an error word still counts when it repeats', () => {
  const msg = (i) => `This agent is isolated in the worktree /work/wt-${i}. Run the command there.`;
  assert.equal(run(toolErrorLoop, errors([0, 1, 2].map(msg))).findings.length, 1);
  assert.equal(sigOf('ugrep: warning: lib/a.ts: No such file or directory'), null);
});

test('file:line is kept verbatim while other digits are masked', () => {
  assert.equal(sigOf('Error: bad value 42 at src/a.ts:17:3'), 'Error: bad value # at src/a.ts:17:3');
});

test('banner, pass-row, marker and soft-phrase regexes stay fast on 200 KB adversarial text', () => {
  const bodies = [
    '='.repeat(200000), '=-'.repeat(100000) + 'x', `${'='.repeat(100000)}x${'='.repeat(100000)}y`, `=== ${'a '.repeat(100000)} ===y`,
    `✔ ${'a.'.repeat(100000)}`, `✔ lineError: ${'a'.repeat(200000)}`, `✖ ${'a-b_'.repeat(50000)}`, `FAIL ${'a.'.repeat(100000)}`,
    '===== x =====\n'.repeat(15000), `${'✔ ok line\n'.repeat(20000)}Error: z`, `No ${'a '.repeat(100000)}found`,
    `Traceback (most recent call last):\n${'File x\n'.repeat(20000)}ValueError: v`, 'abcdef0 '.repeat(25000), `/tmp/${'a'.repeat(200000)}`,
    'a.b:1 '.repeat(30000), `${'a-'.repeat(100000)}guard:`,
  ];
  for (const body of bodies) {
    const started = process.hrtime.bigint();
    const sig = toolErrorLoop.errorSignature(body);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 300, `took ${ms} ms on ${body.slice(0, 20)}`);
    assert.ok(sig === null || sig.length <= 240);
  }
});
