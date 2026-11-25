'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scriptName, hookNames } = require('../scripts/lib/hook-names.js');

const cmd = (command) => ({ hooks: { PreToolUse: [{ hooks: [{ command }] }] } });
const names = (command) => [...hookNames(cmd(command))];

test('scriptName takes the first script basename without extension', () => {
  assert.equal(scriptName('node /home/alice/hooks/lint-guard.js --x'), 'lint-guard');
  assert.equal(scriptName("python3 'a b.py'"), 'b');
  assert.equal(scriptName('bash run.sh'), 'run');
  assert.equal(scriptName('node x.mjs'), 'x');
  assert.equal(scriptName('node "$HOME/.claude/hooks/secret-guard.js" --strict'), 'secret-guard');
});

test('scriptName rejects lookalikes and empty input', () => {
  assert.equal(scriptName('node lint-guard.js/extra'), null);
  assert.equal(scriptName('node lint-guard.jsx'), null);
  assert.equal(scriptName(''), null);
  assert.equal(scriptName(undefined), null);
  assert.equal(scriptName(42), null);
});

test('hookNames reads script basenames from hook commands', () => {
  assert.deepEqual(names('node /home/alice/hooks/lint-guard.js --x'), ['lint-guard']);
  assert.deepEqual(names('node lint-guard.js/extra'), []);
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
