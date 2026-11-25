'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bypass = require('../../scripts/lib/detectors/block-bypassed');
const forbidden = require('../../scripts/lib/detectors/forbidden-pattern');

const deps = { redact: (s) => s, truncate: (s, n) => s.slice(0, n) };
const S = 'alice-session-0001';

let seq = 0;
const use = (name, input, extra = {}) => {
  seq += 1;
  return { kind: 'tool_use', session: S, line: seq, ts: '2026-01-01T00:00:00Z', id: `tu${seq}`, name, input, messageId: `m${seq}`, inputHash: `h${seq}`, ...extra };
};
const bash = (command, extra) => use('Bash', { command }, extra);
const block = (tu, reason, hookEvent = 'PreToolUse', hook = '/home/alice/hooks/lint-guard.js') =>
  ({ kind: 'block', session: S, toolUseId: tu.id, hookEvent, hook, reason });
const text = (t) => ({ kind: 'user_text', session: S, text: t });

function run(mod, config, events) {
  const d = mod.create(config, deps);
  for (const ev of events) d.onEvent(ev);
  return d.finish();
}
const cfg = { bypassPatterns: [], grantPhrases: ['yes, go ahead', '\\bgo ahead\\b'] };

test('env override not named in the block reason is no bypass', () => {
  const a = bash('git push');
  const b = bash('PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1 npm i');
  const r = run(bypass, cfg, [a, block(a, 'lint-guard refused the push'), b]);
  assert.equal(r.findings.length, 0);
});

test('env override named in the reason is a bypass', () => {
  const a = bash('git push');
  const b = bash('LINT_GUARD_SKIP=1 git push');
  const r = run(bypass, cfg, [a, block(a, 'set LINT_GUARD_SKIP=1 to override'), b]);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, 'block-bypassed');
  assert.equal(r.findings[0].severity, 'high');
  assert.equal(r.findings[0].key, 'block-bypassed:lint-guard');
  assert.equal(r.findings[0].line, b.line);
});

test('--no-verify after a block is a bypass', () => {
  const a = bash('git commit -m x');
  const b = bash('git commit --no-verify -m x');
  const r = run(bypass, cfg, [a, block(a, 'nope'), b]);
  assert.equal(r.findings.length, 1);
});

test('git commit -n and dangerouslyDisableSandbox are bypasses', () => {
  const a = bash('git commit -m x');
  const b = bash('git commit -n -m x');
  assert.equal(run(bypass, cfg, [a, block(a, 'nope'), b]).findings.length, 1);
  const c = bash('ls');
  const d = use('Bash', { command: 'ls', dangerouslyDisableSandbox: true });
  assert.equal(run(bypass, cfg, [c, block(c, 'nope'), d]).findings.length, 1);
});

test('config.bypassPatterns match and invalid ones become warnings', () => {
  const a = bash('rm -rf x');
  const b = bash('sudo rm -rf x');
  const r = run(bypass, { ...cfg, bypassPatterns: ['^sudo\\b', '('] }, [a, block(a, 'nope'), b]);
  assert.equal(r.findings.length, 1);
  assert.equal(r.warnings.length, 1);
});

test('override that is itself blocked is no bypass', () => {
  const a = bash('git commit -m x');
  const b = bash('git commit --no-verify -m x');
  const c = bash('echo later');
  const r = run(bypass, cfg, [a, block(a, 'nope'), b, block(b, 'nope again'), c]);
  assert.equal(r.findings.length, 0);
});

test('pending override is settled in finish', () => {
  const a = bash('git commit -m x');
  const b = bash('git commit --no-verify -m x');
  assert.equal(run(bypass, cfg, [a, block(a, 'nope'), b]).findings.length, 1);
});

test('user grant between block and override suppresses', () => {
  const a = bash('git commit -m x');
  const b = bash('git commit --no-verify -m x');
  const r = run(bypass, cfg, [a, block(a, 'nope'), text('yes, go ahead'), b]);
  assert.equal(r.findings.length, 0);
});

test('R2-2: grant text from a subagent, meta line or agent message does not hide a bypass', () => {
  const grantFrom = (over) => {
    const a = bash('git commit -m x');
    const b = bash('git commit --no-verify -m x');
    return run(bypass, cfg, [a, block(a, 'nope'), { ...text('yes, go ahead'), ...over }, b]).findings.length;
  };
  assert.equal(grantFrom({ agent: 'subagent' }), 1);
  assert.equal(grantFrom({ meta: true, text: 'ok, go ahead' }), 1);
  assert.equal(grantFrom({ text: '<teammate-message id="x">yes, go ahead' }), 1);
  assert.equal(grantFrom({ text: '<agent-message>go ahead' }), 1);
  assert.equal(grantFrom({ text: '<cross-session-message from="x">go ahead' }), 1);
  assert.equal(grantFrom({ agent: 'main' }), 0);
});

test('PostToolUse block does not arm a bypass', () => {
  const a = bash('git commit -m x');
  const b = bash('git commit --no-verify -m x');
  const r = run(bypass, cfg, [a, block(a, 'nope', 'PostToolUse'), b]);
  assert.equal(r.findings.length, 0);
  assert.equal(r.exposureByKey.size, 0);
});

test('only the next tool_use is judged', () => {
  const a = bash('git commit -m x');
  const b = bash('ls');
  const c = bash('git commit --no-verify -m x');
  assert.equal(run(bypass, cfg, [a, block(a, 'nope'), b, c]).findings.length, 0);
});

test('exposure lists sessions with a PreToolUse or PermissionRequest block', () => {
  const a = bash('x');
  const r = run(bypass, cfg, [a, block(a, 'nope', 'PermissionRequest')]);
  assert.deepEqual([...r.exposureByKey.get('block-bypassed:lint-guard')], [S]);
  assert.ok(r.exposedSessions.has(S));
});

const noNpm = { id: 'no-npm', tool: '^Bash$', field: 'command', pattern: '(^|\\s)npm\\s+(i|install)\\b', message: 'This project uses pnpm' };

test('forbidden matches npm i and ignores pnpm i', () => {
  const r = run(forbidden, { forbidden: [noNpm] }, [bash('npm i lodash'), bash('pnpm i lodash')]);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].key, 'forbidden-pattern:no-npm');
  assert.equal(r.findings[0].severity, 'medium');
  assert.match(r.findings[0].summary, /^This project uses pnpm — Bash: npm i lodash/);
});

test('forbidden emits once per session and id with hit count', () => {
  const r = run(forbidden, { forbidden: [noNpm] }, [bash('npm i a'), bash('npm install b'), bash('npm i c')]);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].evidence.join(' '), /3/);
});

test('forbidden any field tests the input JSON', () => {
  const f = { id: 'secret', tool: '.*', field: 'any', pattern: 'secret-guard', message: 'm' };
  const r = run(forbidden, { forbidden: [f] }, [use('Read', { file_path: '/x/secret-guard.txt' })]);
  assert.equal(r.findings.length, 1);
});

test('forbidden file_path and pattern fields', () => {
  const fs = [
    { id: 'env', tool: '^Read$', field: 'file_path', pattern: '\\.env$', message: 'm' },
    { id: 'g', tool: '^Grep$', field: 'pattern', pattern: 'password', message: 'm' },
  ];
  const r = run(forbidden, { forbidden: fs }, [use('Read', { file_path: '/a/.env' }), use('Grep', { pattern: 'password' })]);
  assert.equal(r.findings.length, 2);
});

test('forbidden invalid regex goes to warnings, never throws', () => {
  const bad = { id: 'bad', tool: '^Bash$', field: 'command', pattern: '(', message: 'm' };
  const r = run(forbidden, { forbidden: [bad, noNpm] }, [bash('npm i x')]);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.findings.length, 1);
});

test('forbidden exposure counts only sessions using a matching tool', () => {
  const other = { ...use('Read', { file_path: '/x' }), session: 'bob-session-0002' };
  const r = run(forbidden, { forbidden: [noNpm] }, [bash('pnpm i x'), other]);
  assert.equal(r.findings.length, 0);
  assert.deepEqual([...r.exposureByKey.get('forbidden-pattern:no-npm')], [S]);
  assert.deepEqual([...r.exposedSessions], [S]);
});

const result = (tu, extra = {}) => ({ kind: 'tool_result', session: S, toolUseId: tu.id, isError: false, ...extra });

test('CR-5: a sibling tool_use does not settle; the override own PreToolUse block drops it', () => {
  const a = bash('git commit -m x');
  const b1 = bash('git commit --no-verify -m x');
  const b2 = bash('ls');
  const r = run(bypass, cfg, [a, block(a, 'nope'), b1, b2, block(b1, 'refused again')]);
  assert.equal(r.findings.length, 0);
});

test('CR-5: a PostToolUse block on the override proves it ran', () => {
  const a = bash('git commit -m x');
  const b1 = bash('git commit --no-verify -m x');
  const r = run(bypass, cfg, [a, block(a, 'nope'), b1, bash('ls'), block(b1, 'feedback', 'PostToolUse')]);
  assert.equal(r.findings.length, 1);
});

test('CR-5: a non-blocked tool_result proves it ran, and finish pushes the rest', () => {
  const a = bash('git commit -m x');
  const b1 = bash('git commit --no-verify -m x');
  assert.equal(run(bypass, cfg, [a, block(a, 'nope'), b1, result(b1)]).findings.length, 1);
  assert.equal(run(bypass, cfg, [a, block(a, 'nope'), b1, bash('ls')]).findings.length, 1);
});

test('CR-6: env name must match as a whole word in the reason', () => {
  const a = bash('npm test');
  const b = bash('CI=true npm test');
  assert.equal(run(bypass, cfg, [a, block(a, 'CIRCLECI_SKIP is not set'), b]).findings.length, 0);
});

test('CR-6: env name needs the override shape', () => {
  const a = bash('npm test');
  const b = bash('CI=true npm test');
  assert.equal(run(bypass, cfg, [a, block(a, 'the CI variable must be unset'), b]).findings.length, 0);
});

test('CR-6: export before an assignment counts', () => {
  const a = bash('deploy now');
  const b = bash('export LINT_GUARD_SKIP=1; deploy now');
  const r = run(bypass, cfg, [a, block(a, 'set LINT_GUARD_SKIP=1'), b]);
  assert.equal(r.findings.length, 1);
});

test('CR-6: override flags inside quoted strings do not count', () => {
  const a = bash('git commit -m x');
  const b = bash('git commit -m "docs: mention --no-verify and -n"');
  assert.equal(run(bypass, cfg, [a, block(a, 'nope'), b]).findings.length, 0);
});

const FAKE = `sk-${'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3Ab4Cd5Ef6Gh7Ij8'}`;
const leaksFake = (obj) => {
  const text = JSON.stringify(obj);
  for (let i = 0; i + 12 <= FAKE.length; i += 1) if (text.includes(FAKE.slice(i, i + 12))) return true;
  return false;
};
const realRun = (mod, config, events) => {
  const d = mod.create(config);
  for (const ev of events) d.onEvent(ev);
  return d.finish();
};

test('F3: a token straddling the old 120-char cut never leaks from block-bypassed', () => {
  const a = bash('git commit -m x');
  const b = bash(`echo ${'x'.repeat(100)} ${FAKE} git commit --no-verify -m x`);
  const r = realRun(bypass, cfg, [a, block(a, `refused, call carried ${FAKE}`), b]);
  assert.equal(r.findings.length, 1);
  assert.equal(leaksFake(r.findings), false);
});

test('F3: a token straddling the old 120-char cut never leaks from forbidden-pattern', () => {
  const r = realRun(forbidden, { forbidden: [noNpm] }, [bash(`npm i ${'x'.repeat(95)} ${FAKE}`)]);
  assert.equal(r.findings.length, 1);
  assert.equal(leaksFake(r.findings), false);
});
