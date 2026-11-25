'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scriptName, hookNames } = require('../scripts/lib/hook-names.js');

const cmd = (command) => ({ hooks: { PreToolUse: [{ hooks: [{ command }] }] } });
const names = (command) => [...hookNames(cmd(command))];

test('scriptName takes the first script basename without extension', () => {
  assert.equal(scriptName('node /home/alice/hooks/lint-guard.js --x'), 'lint-guard');
  assert.equal(scriptName("python3 'a b.py'"), 'a b');
  assert.equal(scriptName('bash run.sh'), 'run');
  assert.equal(scriptName('node x.mjs'), 'x');
  assert.equal(scriptName('node "$HOME/.claude/hooks/secret-guard.js" --strict'), 'secret-guard');
});

test('scriptName takes the basename of the first path-like token that is not an interpreter', () => {
  const cases = [
    ['C:\\hooks\\guard.ps1', 'guard'],
    ['pwsh -File "C:\\a b\\g.ps1"', 'g'],
    ['powershell -NoProfile -ExecutionPolicy Bypass -File C:\\x\\h.ps1', 'h'],
    ['ruby /x/hook.rb', 'hook'],
    ['perl /x/h.pl', 'h'],
    ['/usr/local/bin/guard-bin --strict', 'guard-bin'],
    ['guard-bin --flag', 'guard-bin'],
    ['./guard.cmd', 'guard'],
    ['C:\\hooks\\run.bat arg', 'run'],
    ['deno run /x/h.ts', 'h'],
    ['bun run /x/h.mjs', 'h'],
    ['npx tsx hook.ts', 'hook'],
    ['uvx my-hook', 'my-hook'],
    ['env FOO=1 node /x/a.cjs', 'a'],
    ['FOO=1 /x/guard', 'guard'],
    ['cd /x && node hook.js', 'hook'],
    ['cd /x && /opt/bin/guard', 'guard'],
    ['node --check /x/lint-guard.js', 'lint-guard'],
    ['go run /x/main.go', 'main'],
    ['python3.11 -u /x/py-guard.py', 'py-guard'],
    ['node /x/a.b.js', 'a.b'],
    ['node "/x y/z/guard.js"', 'guard'],
    ['node lint-guard.js/extra', 'extra'],
    ['node lint-guard.jsx', 'lint-guard'],
  ];
  for (const [command, expected] of cases) assert.equal(scriptName(command), expected, command);
});

test('scriptName returns null when there is nothing script-like', () => {
  for (const command of ['', undefined, null, 42, 'node', 'bash -c', '   ', 'node -e "x(1)"', '/']) {
    assert.equal(scriptName(command), null, String(command));
  }
});

test('hookNames reads script basenames from hook commands', () => {
  assert.deepEqual(names('node /home/alice/hooks/lint-guard.js --x'), ['lint-guard']);
  assert.deepEqual(names('node lint-guard.js/extra'), ['extra']);
  assert.deepEqual(names('C:\\hooks\\guard.ps1'), ['guard']);
  assert.deepEqual(names('node x.mjs'), ['x']);
});

test('hookNames accepts a JSON string and tolerates malformed shapes', () => {
  assert.deepEqual([...hookNames(JSON.stringify(cmd('bash a-b.sh')))], ['a-b']);
  assert.equal(hookNames(null).size, 0);
  assert.equal(hookNames([]).size, 0);
  assert.equal(hookNames({ hooks: { Stop: [null, { hooks: [null, { command: 5 }, {}] }, { hooks: 'x' }] } }).size, 0);
  assert.equal(hookNames({ hooks: 'x' }).size, 0);
});

test('stays linear on a long command without delimiters', () => {
  const started = Date.now();
  assert.equal(scriptName('x'.repeat(150000)), null);
  assert.equal(hookNames({ hooks: { Stop: [{ hooks: [{ command: 'x'.repeat(150000) }] }] } }).size, 0);
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
});

test('the module requires nothing outside node built-ins', () => {
  const src = require('node:fs').readFileSync(require.resolve('../scripts/lib/hook-names.js'), 'utf8');
  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires.filter((r) => !r.startsWith('node:')), []);
});
