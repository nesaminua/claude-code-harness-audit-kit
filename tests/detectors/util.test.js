'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { finding, redactKey } = require('../../scripts/lib/detectors/util.js');

const detector = { id: 'block-loop', severity: 'medium' };
const ev = { session: 'abcdefghij', line: 1, ts: '2026-11-20T12:00:00' };
const secret = 'sk-' + 'ant-api03-' + 'A'.repeat(24);

test('hook and the hook part of the key are redacted', () => {
  const hook = `guard-${secret}`;
  const f = finding(detector, ev, { key: `block-loop:${hook}`, hook, summary: 's' });
  assert.ok(!f.hook.includes(secret) && !f.key.includes(secret), JSON.stringify(f));
  assert.match(f.hook, /<redacted:/);
  assert.match(f.key, /^block-loop:guard-<redacted:/);
});

test('a home path in the hook is masked and the rule prefix of the key survives', () => {
  const hook = '/Users/alice/dev/acme/hooks/lint-guard';
  const f = finding(detector, ev, { key: `block-loop:${hook}`, hook, summary: 's' }, undefined);
  assert.ok(!f.hook.includes('alice') && !f.key.includes('alice'), JSON.stringify(f));
  assert.ok(f.key.startsWith('block-loop:'));
});

test('a clean hook and key pass through unchanged, null hook stays null', () => {
  const f = finding(detector, ev, { key: 'block-loop:lint-guard', hook: 'lint-guard', summary: 's' });
  assert.equal(f.key, 'block-loop:lint-guard');
  assert.equal(f.hook, 'lint-guard');
  assert.equal(finding(detector, ev, { key: 'k', summary: 's' }).hook, null);
});

test('redactKey(key) equals the key finding() stores, so exposure keys can be mapped to match', () => {
  const key = `block-loop:guard-${secret}`;
  const f = finding(detector, ev, { key, hook: `guard-${secret}`, summary: 's' });
  assert.equal(redactKey(key), f.key);
  assert.ok(!redactKey(key).includes(secret));
  assert.equal(redactKey('block-loop:lint-guard'), 'block-loop:lint-guard');
  assert.equal(redactKey('no-colon'), 'no-colon');
});

const { commandShape, describeCall } = require('../../scripts/lib/detectors/util.js');

const V = 'Zq8xKp2mWv';
const SHAPES = [
  ['git commit --no-verify -m "fix: x"', 'git commit --no-verify -m …', []],
  ['LINT_GUARD_SKIP=1 git push origin main', 'LINT_GUARD_SKIP=… git push …', ['origin']],
  ['curl -H "Authorization: Bearer x" https://a/b', 'curl -H … …', []],
  [`API_KEY=${V} npm test`, 'API_KEY=… npm test', [V]],
  [`echo ${V}`, 'echo …', [V]],
  [`mysql -p${V} db`, 'mysql …', [V]],
  [`mysql --password=${V} db`, 'mysql --password …', [V]],
  [`cli --token ${V}`, 'cli --token …', [V]],
  [`echo "a && ${V}; rm"`, 'echo …', [V]],
  [`cat x | grep ${V} && ls`, 'cat … | grep … && ls', [V]],
  [`/usr/local/bin/tool --flag-x /home/alice/secret-${V}`, 'tool --flag-x …', [V]],
  [`curl https://u:${V}@h.example/x`, 'curl …', [V]],
  [`gh pr create --title "t" --body ${V}`, 'gh pr create --title … --body …', [V]],
  [`export TOKEN=${V}; deploy`, 'export TOKEN=… ; deploy', [V]],
  ['npm test 2>&1 | tail -5', 'npm test … | tail …', []],
  [`echo "${V}`, 'echo …', [V]],
  [`git push ${V}`, 'git push …', [V]],
  [`docker run -e KEY=${V} img`, 'docker run -e KEY=… …', [V]],
  [`env -i ${V}=1 run`, 'env -i … …', [V]],
];

for (const [input, expected, secrets] of SHAPES) {
  test(`commandShape: ${input.slice(0, 50).replace(/Zq8xKp2mWv/g, 'VALUE')}`, () => {
    const shape = commandShape(input);
    assert.equal(shape, expected);
    for (const secret of secrets) {
      for (let i = 0; i + 6 <= secret.length; i += 1) assert.ok(!shape.includes(secret.slice(i, i + 6)), shape);
    }
  });
}

test('commandShape: empty and non-string input give an empty shape, long input is capped at 160', () => {
  assert.equal(commandShape(''), '');
  assert.equal(commandShape(undefined), '');
  assert.equal(commandShape(`echo ${Array.from({ length: 80 }, (_, i) => `--flag-${i}`).join(' ')}`).length, 160);
});

test('describeCall: Bash gives the shape, file tools the file basename only, others the name', () => {
  assert.equal(describeCall('Bash', { command: `git push origin ${V}` }), 'git push …');
  assert.equal(describeCall('Edit', { file_path: `/home/alice/proj/src/a.js`, old_string: V, new_string: V }), 'Edit a.js');
  assert.equal(describeCall('Write', { file_path: 'C:\\Users\\alice\\b.txt', content: V }), 'Write b.txt');
  assert.equal(describeCall('Grep', { pattern: V }), 'Grep');
});
