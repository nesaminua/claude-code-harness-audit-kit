'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');

const { listTranscripts, normalize, hookNames } = require('../scripts/lib/transcript.js');

const PROJECTS = path.join(__dirname, 'fixtures', 'transcripts', 'projects');
const PROJ = path.join(PROJECTS, '-Users-alice-dev-acme');
const SINCE = Date.parse('2026-11-20T00:00:00Z');
const NAMES = new Set(['lint-guard', 'secret-guard']);

async function collect(name, opts = {}) {
  const out = [];
  const file = path.join(PROJ, `${name}.jsonl`);
  for await (const e of normalize(file, { sinceMs: SINCE, kind: 'main', hookNames: NAMES, ...opts })) out.push(e);
  return out;
}
const of = (evs, kind) => evs.filter((e) => e.kind === kind);

test('json-deny banner without attachment becomes one block', async () => {
  const evs = await collect('json-deny-banner');
  const blocks = of(evs, 'block');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].toolUseId, 't1');
  assert.equal(blocks[0].hook, 'BASH READ GUARD');
  assert.equal(blocks[0].hookEvent, 'PreToolUse');
  assert.match(blocks[0].reason, /use the Read tool/);
  assert.equal(of(evs, 'tool_result').length, 0);
});

test('json-deny "<hook>:" form needs a known hook name', async () => {
  const evs = await collect('json-deny-name');
  const blocks = of(evs, 'block');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].hook, 'lint-guard');
  const results = of(evs, 'tool_result');
  assert.equal(results.length, 1);
  assert.equal(results[0].toolUseId, 't2');
  assert.equal(results[0].isError, true);
});

test('prefixed block names the hook script and strips the prefix', async () => {
  const [b] = of(await collect('prefixed'), 'block');
  assert.equal(b.hook, 'secret-guard');
  assert.equal(b.hookEvent, 'PreToolUse');
  assert.equal(b.reason, 'secret in command');
});

test('attachment block and its is_error result count once', async () => {
  const evs = await collect('attachment-dup');
  const blocks = of(evs, 'block');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].hook, 'lint-guard');
  assert.equal(blocks[0].reason, 'no lint bypass');
  assert.equal(blocks[0].toolUseId, 't1');
  assert.equal(of(evs, 'tool_result').length, 0);
});

test('PostToolUse attachment block uses content as the reason', async () => {
  const evs = await collect('posttooluse-block');
  const [b] = of(evs, 'block');
  assert.equal(b.hookEvent, 'PostToolUse');
  assert.equal(b.reason, 'file touched outside scope');
  assert.equal(of(evs, 'tool_result').length, 1);
});

test('hook_success with a crash line is a crash', async () => {
  const [e] = of(await collect('crash'), 'hook_error');
  assert.equal(e.type, 'crash');
  assert.equal(e.hook, 'secret-guard');
  assert.equal(e.hookEvent, 'PreToolUse');
  assert.match(e.detail, /TypeError/);
});

test('quoted error text is an advisory, not a crash', async () => {
  assert.equal(of(await collect('advisory-quoted'), 'hook_error').length, 0);
});

test('bullet-line errors are not crashes', async () => {
  assert.equal(of(await collect('advisory-bullet'), 'hook_error').length, 0);
});

test('SyntaxError right after editing the hook file is dropped', async () => {
  assert.equal(of(await collect('mid-edit-syntax'), 'hook_error').length, 0);
});

test('SyntaxError more than 10 tool_use events after the edit is kept', async () => {
  const errs = of(await collect('stale-syntax'), 'hook_error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].type, 'crash');
});

test('hook_cancelled with timedOut is a timeout', async () => {
  const [e] = of(await collect('timeout'), 'hook_error');
  assert.equal(e.type, 'timeout');
  assert.equal(e.hook, 'secret-guard');
});

test('a timeout 50x past its budget is the machine sleeping and is dropped', async () => {
  assert.equal(of(await collect('sleep-timeout'), 'hook_error').length, 0);
});

test('hook_non_blocking_error maps to non_blocking', async () => {
  const [e] = of(await collect('non-blocking'), 'hook_error');
  assert.equal(e.type, 'non_blocking');
  assert.match(e.detail, /config missing/);
});

test('replayed tool_use id is ignored, malformed lines skipped, hash is stable', async () => {
  const uses = of(await collect('replay'), 'tool_use');
  assert.deepEqual(uses.map((u) => u.id), ['t1', 't2']);
  assert.equal(uses[0].messageId, 'm1');
  assert.equal(uses[0].agent, 'main');
  assert.equal(uses[0].session, 'sess-1');
  assert.equal(uses[1].session, 'sess-legacy');
  assert.equal(uses[0].inputHash, uses[1].inputHash);
  const expected = crypto.createHash('sha1').update('Bash{"a":2,"b":1,"command":"ls"}').digest('hex');
  assert.equal(uses[0].inputHash, expected);
  assert.equal(uses[0].line, 1);
});

test('events outside [sinceMs, untilMs) are dropped; untimestamped lines inherit', async () => {
  const from = Date.parse('2026-11-20T10:00:00Z');
  const wide = await collect('window', { sinceMs: from });
  assert.deepEqual(of(wide, 'user_text').map((e) => e.text), ['inside', 'too late']);
  assert.deepEqual(of(wide, 'assistant_text').map((e) => e.text), ['untimestamped inside']);
  const narrow = await collect('window', { sinceMs: from, untilMs: Date.parse('2026-11-20T11:00:00Z') });
  assert.deepEqual(of(narrow, 'user_text').map((e) => e.text), ['inside']);
});

test('system reminders are stripped and tool_result blocks excluded from user_text', async () => {
  const evs = await collect('reminders');
  assert.deepEqual(of(evs, 'user_text').map((e) => e.text), ['real words', 'second\nmessage']);
  const [r] = of(evs, 'tool_result');
  assert.equal(r.toolUseId, 't9');
  assert.equal(r.isError, false);
  assert.equal(r.text, 'tool output');
});

test('subagent transcripts are listed with their kind and tagged agent', async () => {
  const listed = listTranscripts({ projectsDir: PROJECTS, sinceMs: 0 });
  const sub = listed.filter((l) => l.kind === 'subagent');
  assert.equal(sub.length, 1);
  assert.equal(sub[0].project, '-Users-alice-dev-acme');
  assert.ok(sub[0].file.endsWith(path.join('sess-9', 'subagents', 'agent-1.jsonl')));
  assert.ok(listed.filter((l) => l.kind === 'main').length >= 15);
  assert.ok(!listed.some((l) => l.project === 'memory'));

  const out = [];
  for await (const e of normalize(sub[0].file, { sinceMs: SINCE, kind: 'subagent' })) out.push(e);
  assert.equal(of(out, 'tool_use')[0].agent, 'subagent');
});

test('listTranscripts filters by mtime', () => {
  assert.deepEqual(listTranscripts({ projectsDir: PROJECTS, sinceMs: Date.now() + 3600e3 }), []);
  assert.deepEqual(listTranscripts({ projectsDir: path.join(PROJECTS, 'absent'), sinceMs: 0 }), []);
});

test('hookNames collects script basenames from every settings.hooks event', () => {
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node /home/alice/.claude/hooks/lint-guard.js' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/secret-guard.js" --strict' }, { type: 'command', command: 'bash ./check.sh' }] }],
    },
  };
  assert.deepEqual([...hookNames(settings)].sort(), ['check', 'lint-guard', 'secret-guard']);
  assert.equal(hookNames({}).size, 0);
});

test('transcript.js shares the parser with the hook (details: hook-names.test.js)', () => {
  assert.equal(hookNames, require('../scripts/lib/hook-names.js').hookNames);
});

const fs = require('node:fs');
const os = require('node:os');

async function eventsOf(lines, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-kit-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  try {
    const out = [];
    for await (const e of normalize(file, opts)) out.push(e);
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const TS = '2026-03-10T11:30:00.000Z';
const textLine = (type, text, extra = {}) => ({ type, sessionId: 'alice-s1', timestamp: TS, message: { content: text }, ...extra });

test('user_text and assistant_text carry the file kind and the meta flag', async () => {
  const lines = [
    textLine('user', 'plain'),
    textLine('user', 'injected', { isMeta: true }),
    textLine('user', 'summary', { isCompactSummary: true }),
    textLine('assistant', 'reply'),
  ];
  const sub = await eventsOf(lines, { kind: 'subagent' });
  assert.deepEqual(sub.map((e) => [e.kind, e.agent, e.meta]), [
    ['user_text', 'subagent', false], ['user_text', 'subagent', true],
    ['user_text', 'subagent', true], ['assistant_text', 'subagent', false],
  ]);
  const main = await eventsOf(lines);
  assert.ok(main.every((e) => e.agent === 'main'));
});

test('hook_run is emitted for every run that finished, not for blocks', async () => {
  const att = (type, extra = {}) => ({ type: 'attachment', sessionId: 'alice-s1', timestamp: TS,
    attachment: { type, hookName: 'PreToolUse:Bash', command: 'node /home/alice/hooks/lint-guard.js', stderr: '', ...extra } });
  const evs = await eventsOf([
    att('hook_success'), att('hook_non_blocking_error', { exitCode: 1 }), att('hook_cancelled', { timedOut: true, timeoutMs: 10 }),
    att('hook_blocking_error', { toolUseID: 't1', content: 'no' }),
  ]);
  const runs = evs.filter((e) => e.kind === 'hook_run');
  assert.equal(runs.length, 3);
  assert.ok(runs.every((e) => e.hook === 'lint-guard' && e.hookEvent === 'PreToolUse' && e.session === 'alice-s1'));
  assert.equal(evs.filter((e) => e.kind === 'block').length, 1);
});

const GB = path.join(__dirname, 'fixtures', 'transcripts', 'group-b', '-Users-alice-dev-acme');
const gbEvents = async (name) => {
  const out = [];
  for await (const e of normalize(path.join(GB, `${name}.jsonl`), { sinceMs: SINCE, kind: 'main' })) out.push(e);
  return out;
};

test('hook_run carries durationMs, timeoutMs and the raw version', async () => {
  const runs = (await gbEvents('slow-hooks')).filter((e) => e.kind === 'hook_run');
  assert.equal(runs.length, 12);
  assert.equal(runs[0].durationMs, 6000);
  assert.equal(runs[0].timeoutMs, 30000);
  assert.equal(runs[0].hook, 'lint-guard');
  assert.equal(runs[0].version, '2.1.0');
});

test('every event type carries version when the line has one, and omits it otherwise', async () => {
  const evs = await gbEvents('usage-limit');
  assert.ok(evs.length > 0 && evs.every((e) => e.version === '2.1.0'));
  const plain = await collect('prefixed');
  assert.ok(plain.every((e) => !('version' in e) || e.version === undefined));
});

test('max_turns_reached becomes a max_turns event with the agent type', async () => {
  const evs = (await gbEvents('max-turns')).filter((e) => e.kind === 'max_turns');
  assert.deepEqual(evs.map((e) => e.agentType), ['reviewer-bot', null]);
  assert.equal(evs[0].session, 'sess-b');
});

test('usage_limit comes only from failure-shaped carriers', async () => {
  const evs = (await gbEvents('usage-limit')).filter((e) => e.kind === 'usage_limit');
  assert.deepEqual(evs.map((e) => [e.model, e.agent]), [['Opus', null], ['Fable', 'worker-1']]);
});

test('events carry the entrypoint of the file, even those before the first line that names it', async () => {
  const evs = await gbEvents('max-turns-sdk');
  assert.ok(evs.some((e) => e.entrypoint === 'sdk-cli'));
  const cli = await gbEvents('max-turns');
  assert.ok(cli.every((e) => !e.entrypoint || e.entrypoint === 'cli'));
  assert.ok((await collect('prefixed')).every((e) => e.entrypoint === undefined));
});

const denyLines = (text) => [
  { type: 'assistant', sessionId: 'alice-s1', timestamp: TS, message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
  { type: 'user', sessionId: 'alice-s1', timestamp: TS, message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: text }] } },
];

test('a "<name>:" deny is a block for any installed hook name, in any case; unknown prefixes stay errors', async () => {
  const names = new Set(['guard', 'my_guard', 'v2.guard']);
  const blockOf = async (text) => (await eventsOf(denyLines(text), { hookNames: names })).filter((e) => e.kind === 'block');
  for (const [text, hook] of [['guard: no rm here', 'guard'], ['My_Guard: no rm here', 'my_guard'], ['v2.guard: nope', 'v2.guard'], ['GUARD: blocked', 'guard']]) {
    const [b] = await blockOf(text);
    assert.ok(b, text);
    assert.equal(b.hook.toLowerCase(), hook);
    assert.equal(b.toolUseId, 't1');
  }
  assert.deepEqual(await blockOf('foo: no rm here'), []);
  const evs = await eventsOf(denyLines('foo: no rm here'), { hookNames: names });
  assert.equal(evs.filter((e) => e.kind === 'tool_result' && e.isError).length, 1);
  assert.deepEqual(await blockOf('guard:no space after the colon'), []);
});
