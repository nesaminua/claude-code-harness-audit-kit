'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { commandShape, describeCall } = require('../../scripts/lib/detectors/command-shape.js');

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

const PW = 'Qx7v-Lr2m_Xk8p';
const noRun = (shape, secret = PW) => {
  for (let i = 0; i + 6 <= secret.length; i += 1) assert.ok(!shape.includes(secret.slice(i, i + 6)), `${secret} in ${shape}`);
};

const BODIES = [
  ['unquoted terminator', `cat > f <<EOF\n${PW}\nEOF`, 'cat …'],
  ['single-quoted terminator', `cat > f <<'EOF'\n${PW}\nEOF`, 'cat …'],
  ['double-quoted terminator', `cat > f <<"EOF"\n${PW}\nEOF`, 'cat …'],
  ['<<- with a tab-indented terminator', `cat > f <<-EOF\n\t${PW}\n\tEOF`, 'cat …'],
  ['unterminated heredoc', `cat > f <<EOF\n${PW}\nmore ${PW}`, 'cat …'],
  ['two heredocs in one command', `cat <<A <<B\n${PW}\nA\nsecond-${PW}\nB`, 'cat …'],
  ['commands after the terminator are kept', `cat <<EOF\n${PW}\nEOF\nls -la`, 'cat … ; ls -la'],
  ['an apostrophe inside the body', `cat <<EOF\ndon't ${PW}\nEOF\necho ok`, 'cat … ; echo …'],
  ['a here-string is just a value', `cat <<< ${PW}`, 'cat …'],
  ['$( ) body', `echo $(echo ${PW})`, 'echo …'],
  ['nested $( ) with a quote', `echo $(printf "%s" '${PW}' | tr a b) done`, 'echo …'],
  ['backtick body', `echo \`cat ${PW}\``, 'echo …'],
  ['unterminated $( )', `echo $(echo ${PW}`, 'echo …'],
  ['$( ) as the command word', `$(echo ${PW}) --flag-x`, '… --flag-x'],
];

for (const [name, input, expected] of BODIES) {
  test(`commandShape body: ${name}`, () => {
    const shape = commandShape(input);
    assert.equal(shape, expected);
    noRun(shape);
  });
}

test('N7 regression: a heredoc password never reaches a finding through the detectors', () => {
  const forbidden = require('../../scripts/lib/detectors/forbidden-pattern');
  const retry = require('../../scripts/lib/detectors/retry-verbatim');
  const bypass = require('../../scripts/lib/detectors/block-bypassed');
  const deps = { redact: (s) => s, truncate: (s, n) => s.slice(0, n) };
  const command = `LINT_GUARD_SKIP=1 cat > ~/.config/app/db.pw <<EOF\n${PW}\nEOF`;
  const call = (id, over = {}) => ({ kind: 'tool_use', session: 'alice-s1', line: 1, ts: 't', id, name: 'Bash', input: { command }, messageId: id, inputHash: 'same', ...over });
  const blockOf = (tu) => ({ kind: 'block', session: 'alice-s1', toolUseId: tu.id, hookEvent: 'PreToolUse', hook: 'lint-guard.js', reason: 'set LINT_GUARD_SKIP=1 to override' });

  const f = forbidden.create({ forbidden: [{ id: 'no-heredoc', tool: '^Bash$', field: 'command', pattern: '<<', message: 'no heredocs' }] }, deps);
  f.onEvent(call('a'));
  const a = call('b');
  const b = call('c');
  const r = retry.create({}, deps);
  for (const ev of [a, blockOf(a), b]) r.onEvent(ev);
  const x = bypass.create({ bypassPatterns: [] }, deps);
  for (const ev of [a, blockOf(a), b]) x.onEvent(ev);

  const all = [...f.finish().findings, ...r.finish().findings, ...x.finish().findings];
  assert.equal(all.length, 3);
  noRun(JSON.stringify(all));
});

test('util.js re-exports the command-shape helpers unchanged', () => {
  const util = require('../../scripts/lib/detectors/util.js');
  const shape = require('../../scripts/lib/detectors/command-shape.js');
  assert.equal(util.commandShape, shape.commandShape);
  assert.equal(util.describeCall, shape.describeCall);
  assert.equal(util.shellTokens, shape.shellTokens);
});
