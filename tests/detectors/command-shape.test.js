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
  ['everything after the << is masked, the terminator is never searched', `cat <<EOF\n${PW}\nEOF\nls -la`, 'cat …'],
  ['an apostrophe inside the body', `cat <<EOF\ndon't ${PW}\nEOF\necho ok`, 'cat …'],
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

// ---- N7-R: substitution bodies are scanned as their own quoting context; anything unbalanced masks to the end ----
const SUBS = [
  ['reviewer repro 1: a ")" in a heredoc body inside $( )', `X=$(cat <<EOF\nfoo)\n${PW}\nEOF\n)`],
  ['reviewer repro 2: an odd quote in a heredoc body inside "$( )"', `git commit -m "$(cat <<'EOF'\nsay "hi\n${PW}\nEOF\n)"`],
  ['reviewer repro 3: ssh with an odd quote in the body', `ssh box "$(cat <<'EOF'\necho "starting\n${PW}\nEOF\n)"`],
  ['case pattern with ")"', `echo $(case x in a) echo ${PW};; esac)`],
  ['quoted ")" inside the body', `echo $(echo ")" ${PW})`],
  ['single-quoted ")" inside the body', `echo $(echo ')' ${PW})`],
  ['"$(printf ... "PW")" nested quotes', `echo "$(printf '%s' "${PW}")"`],
  ['nested $( $( ) )', `echo $( $( echo ${PW} ) )`],
  ['nested three deep with quotes', `echo $(a "$(b '$(c ${PW})')")`],
  ['unbalanced $( at the end', `ls $(echo ${PW}`],
  ['unbalanced nested $(', `ls $(echo $(echo ${PW})`],
  ['unterminated heredoc inside $( )', `echo $(cat <<EOF\n${PW}\nmore ${PW}`],
  ['backtick with a heredoc inside', `echo \`cat <<EOF\n${PW}\nEOF\n\` done`],
  ['unbalanced backtick', `echo \`cat ${PW}`],
  ['odd quote after a substitution keeps masking', `echo "$(echo a)" "unterminated ${PW}`],
  ['arithmetic and subshell parens', `echo $(( 1 + 2 )) $( (cd /x; echo ${PW}) )`],
];

for (const [name, input] of SUBS) {
  test(`N7-R shape: ${name}`, () => {
    const shape = commandShape(input);
    noRun(shape);
    assert.ok(/^[A-Za-z]/.test(shape) || shape.startsWith('X='), shape);
  });

  test(`N7-R detector: ${name}`, () => {
    const forbidden = require('../../scripts/lib/detectors/forbidden-pattern');
    const deps = { redact: (s) => s, truncate: (s, n) => s.slice(0, n) };
    const d = forbidden.create({ forbidden: [{ id: 'any-bash', tool: '^Bash$', field: 'command', pattern: '.', message: 'm' }] }, deps);
    d.onEvent({ kind: 'tool_use', session: 'alice-s1', line: 1, ts: 't', id: 'a', name: 'Bash', input: { command: input }, messageId: 'a', inputHash: 'h' });
    const findings = d.finish().findings;
    assert.equal(findings.length, 1);
    noRun(JSON.stringify(findings));
  });
}

test('N7-R: a balanced substitution still keeps what follows it', () => {
  assert.equal(commandShape(`echo $(echo ")" ${PW}) --flag-x`), 'echo … --flag-x');
  assert.equal(commandShape(`echo "$(printf '%s' "${PW}")" --flag-x`), 'echo … --flag-x');
  assert.equal(commandShape(`echo $( $( echo ${PW} ) ) ; ls -la`), 'echo … ; ls -la');
  assert.equal(commandShape(`git commit -m "$(cat <<'EOF'\n${PW}\nEOF\n)" --no-verify`), 'git commit -m …');
});

test('N7-R: unbalanced input masks everything after the opener as one marker', () => {
  assert.equal(commandShape(`ls $(echo ${PW}; rm -rf x`), 'ls …');
  assert.equal(commandShape(`ls $(`), 'ls …');
});

test('N7-R: 200 KB adversarial substitution input finishes under 300 ms', () => {
  const { shellTokens } = require('../../scripts/lib/detectors/command-shape.js');
  const shapes = ['$(', '"$(', '`', '$($(', '$(case x in a) ', '$(cat <<E\n', '$(echo ")" ', "$(echo ' ", '"$(" ', '$( ( ', '<<A\n$(', '$(a "'];
  for (const unit of shapes) {
    const input = unit.repeat(Math.ceil(204800 / unit.length)).slice(0, 204800);
    const t0 = process.hrtime.bigint();
    commandShape(input);
    shellTokens(input);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 300, `${JSON.stringify(unit)} took ${ms.toFixed(0)} ms`);
  }
});

// ---- N7-R2: the first << anywhere masks the rest of the command ----
const HEREDOCS = [
  ['reviewer repro: ssh with an apostrophe in the body', `ssh h 'cat > f <<EOF\ndon't\n${PW}\nEOF'`, 'ssh …'],
  ['reviewer repro: bash -c with an odd double quote', `bash -c "cat > f <<EOF\nsay "hi\n${PW}\nEOF"`, 'bash -c …'],
  ['bash -c with a quoted terminator', `bash -c "cat <<'EOF'\n${PW}\nEOF"`, 'bash -c …'],
  ['ssh with a quoted apostrophe pair', `ssh h 'cat <<EOF\n${PW}'"'"'\nEOF'`, 'ssh …'],
  ['heredoc inside $( ) inside bash -c', `sh -c "x=\\$(cat <<E\n${PW}\nE)"`, 'sh -c …'],
  ['flags before the << are kept', `git commit --no-verify -F - <<EOF\n${PW}\nEOF`, 'git commit --no-verify -F …'],
  ['<<- with a command after', `cat <<-EOF\n\t${PW}\n\tEOF\nrm -rf x`, 'cat …'],
  ['a << shift in arithmetic masks the rest (fail-safe)', `echo $((1<<3)) ${PW}`, 'echo …'],
];

for (const [name, input, expected] of HEREDOCS) {
  test(`N7-R2 shape: ${name}`, () => {
    const shape = commandShape(input);
    assert.equal(shape, expected);
    noRun(shape);
  });

  test(`N7-R2 detector: ${name}`, () => {
    const forbidden = require('../../scripts/lib/detectors/forbidden-pattern');
    const deps = { redact: (s) => s, truncate: (s, n) => s.slice(0, n) };
    const d = forbidden.create({ forbidden: [{ id: 'any-bash', tool: '^Bash$', field: 'command', pattern: '.', message: 'm' }] }, deps);
    d.onEvent({ kind: 'tool_use', session: 'alice-s1', line: 1, ts: 't', id: 'a', name: 'Bash', input: { command: input }, messageId: 'a', inputHash: 'h' });
    const findings = d.finish().findings;
    assert.equal(findings.length, 1);
    noRun(JSON.stringify(findings));
  });
}

test('N7-R2: a here-string masks only its word, the rest of the command keeps its shape', () => {
  assert.equal(commandShape(`cat <<< ${PW} --flag-x`), 'cat … --flag-x');
  assert.equal(commandShape(`grep -q x <<<"${PW}" && ls -la`), 'grep -q … … && ls -la');
});
