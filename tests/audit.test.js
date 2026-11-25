'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const report = require('../scripts/lib/report');
const { main } = require('../scripts/audit');
const { localDay } = require('../scripts/lib/paths');

const ENV_KEYS = ['HARNESS_AUDIT_KIT_HOME', 'HARNESS_AUDIT_CLAUDE_DIR'];
const quiet = { out: () => {} };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-kit-'));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HARNESS_AUDIT_KIT_HOME = path.join(root, 'kit');
  process.env.HARNESS_AUDIT_CLAUDE_DIR = path.join(root, 'claude');
  fs.mkdirSync(process.env.HARNESS_AUDIT_KIT_HOME, { recursive: true });
  fs.mkdirSync(process.env.HARNESS_AUDIT_CLAUDE_DIR, { recursive: true });
  const restore = () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, kit: process.env.HARNESS_AUDIT_KIT_HOME, claude: process.env.HARNESS_AUDIT_CLAUDE_DIR, restore };
}

function dayBefore(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

const stamp = (day, sec) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12, 0, sec).toISOString();

function toolUse(day, sec, session, id, command) {
  return { type: 'assistant', sessionId: session, timestamp: stamp(day, sec),
    message: { id: `msg-${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } };
}

function blockResult(day, sec, session, id) {
  return { type: 'user', sessionId: session, timestamp: stamp(day, sec),
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true,
      content: 'PreToolUse:Bash hook error: [node /home/alice/hooks/lint-guard.js]: lint failed in 3 files' }] } };
}

function okResult(day, sec, session, id) {
  return { type: 'user', sessionId: session, timestamp: stamp(day, sec),
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'ok' }] } };
}

function writeTranscript(claude, name, events) {
  const dir = path.join(claude, 'projects', '-Users-alice-dev-acme');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function seed(env, day) {
  fs.writeFileSync(path.join(env.kit, 'config.json'), JSON.stringify({
    forbidden: [{ id: 'no-npm', tool: '^Bash$', field: 'command', pattern: '(^|\\s)npm\\s+(i|install)\\b', message: 'Use pnpm' }],
  }));
  fs.writeFileSync(path.join(env.claude, 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node /home/alice/hooks/lint-guard.js' }] }] },
  }));
  const loop = [];
  for (let i = 0; i < 3; i += 1) {
    loop.push(toolUse(day, i * 2, 'alice-sess-loop', `tu${i}`, `pnpm lint ${i}`), blockResult(day, i * 2 + 1, 'alice-sess-loop', `tu${i}`));
  }
  writeTranscript(env.claude, 'sess-loop', loop);
  writeTranscript(env.claude, 'sess-npm', [
    toolUse(day, 0, 'alice-sess-npm', 'tn0', 'npm i lodash'), okResult(day, 1, 'alice-sess-npm', 'tn0'),
  ]);
}

function listFiles(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile()).map((e) => path.join(e.parentPath || e.path, e.name));
}

test('audit writes queue, report, state and leaks no path', async () => {
  const env = setup();
  try {
    const day = dayBefore(1);
    const date = localDay(day);
    seed(env, day);
    await main(['--date', date], quiet);

    const queue = JSON.parse(fs.readFileSync(path.join(env.kit, 'data', 'queue.json'), 'utf8'));
    assert.deepEqual(queue.open.map((i) => i.key).sort(), ['block-loop:lint-guard', 'forbidden-pattern:no-npm']);

    const reports = path.join(env.kit, 'data', 'reports');
    const rep = JSON.parse(fs.readFileSync(path.join(reports, `${date}.json`), 'utf8'));
    assert.ok(fs.existsSync(path.join(reports, `${date}.md`)));
    assert.ok('block-loop:lint-guard' in rep.daily[date] && 'forbidden-pattern:no-npm' in rep.daily[date]);
    assert.deepEqual(rep.daily[date]['retry-verbatim:lint-guard'], { hitSessions: 0, exposedSessions: 1 });
    assert.equal(rep.daily[date]['block-loop:lint-guard'].hitSessions, 1);
    assert.equal(rep.daily[date]['block-loop:lint-guard'].exposedSessions, 1);

    const state = JSON.parse(fs.readFileSync(path.join(env.kit, 'data', 'state.json'), 'utf8'));
    assert.equal(state.audited_through, date);
    assert.ok(fs.existsSync(path.join(env.kit, 'data', 'efficacy.json')));

    const hitsBefore = queue.open.map((i) => i.hits);
    await main(['--date', date], quiet);
    const again = JSON.parse(fs.readFileSync(path.join(env.kit, 'data', 'queue.json'), 'utf8'));
    assert.deepEqual(again.open.map((i) => i.hits), hitsBefore);
    const rep2 = JSON.parse(fs.readFileSync(path.join(reports, `${date}.json`), 'utf8'));
    assert.deepEqual(rep2.daily, rep.daily);

    for (const file of listFiles(env.kit)) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!text.includes('/Users/alice'), `${file} leaks a path`);
      assert.ok(!text.includes('-Users-alice'), `${file} leaks a project dir`);
    }
  } finally {
    env.restore();
  }
});

test('since-last with no state audits yesterday only; a second run has nothing to do', async () => {
  const env = setup();
  try {
    seed(env, dayBefore(1));
    const first = await main(['--json'], quiet);
    assert.deepEqual(first.days, [localDay(dayBefore(1))]);
    const second = await main(['--json'], quiet);
    assert.deepEqual(second.days, []);
  } finally {
    env.restore();
  }
});

test('a bypass followed by more calls reaches the queue as a keyed finding', async () => {
  const env = setup();
  try {
    const day = dayBefore(1);
    const s = 'alice-sess-bypass';
    writeTranscript(env.claude, 'sess-bypass', [
      toolUse(day, 0, s, 'b0', 'git commit -m one'), blockResult(day, 1, s, 'b0'),
      toolUse(day, 2, s, 'b1', 'git commit --no-verify -m one'), okResult(day, 3, s, 'b1'),
      toolUse(day, 4, s, 'b2', 'ls'), okResult(day, 5, s, 'b2'),
    ]);
    const res = await main(['--date', localDay(day), '--json'], quiet);
    const queue = JSON.parse(fs.readFileSync(path.join(env.kit, 'data', 'queue.json'), 'utf8'));
    assert.ok(res.findings >= 1);
    assert.ok(queue.open.every((i) => typeof i.key === 'string' && i.key.length > 0));
    assert.ok(queue.open.some((i) => i.key === 'block-bypassed:lint-guard'));
  } finally {
    env.restore();
  }
});

test('ignoreProjects skips a project', async () => {
  const env = setup();
  try {
    const day = dayBefore(1);
    seed(env, day);
    const cfg = path.join(env.kit, 'config.json');
    const merged = { ...JSON.parse(fs.readFileSync(cfg, 'utf8')), ignoreProjects: ['acme'] };
    fs.writeFileSync(cfg, JSON.stringify(merged));
    const res = await main(['--date', localDay(day), '--json'], quiet);
    assert.equal(res.findings, 0);
  } finally {
    env.restore();
  }
});

const sampleReport = (over = {}) => report.buildReport({
  date: '2026-01-10', window: { since: '2026-01-10', until: '2026-01-10' },
  findings: [
    { rule: 'block-loop', key: 'block-loop:lint-guard', severity: 'high', session: 's1', hook: 'lint-guard', summary: 'lint-guard blocked 3x | same', evidence: [] },
    { rule: 'block-loop', key: 'block-loop:lint-guard', severity: 'high', session: 's2', hook: 'lint-guard', summary: 'again', evidence: [] },
    { rule: 'user-correction', key: 'user-correction:x', severity: 'low', session: 's1', hook: null, summary: 'no', evidence: [] },
  ],
  daily: {}, warnings: ['bad regex dropped'], stats: { transcripts: 4 }, ...over,
});

test('renderMarkdown has summary line, rule table, top 10 open items and warnings', () => {
  const open = Array.from({ length: 12 }, (_, i) => ({ id: `id${String(i).padStart(2, '0')}`, rule: 'block-loop',
    seen_days: ['2026-01-09', '2026-01-10'], examples: [{ hook: 'lint-guard' }], title: `item ${i}` }));
  const md = report.renderMarkdown(sampleReport(), { open });
  assert.match(md, /Findings: 3/);
  assert.match(md, /Sessions: 2/);
  assert.match(md, /Transcripts: 4/);
  assert.match(md, /Open items: 12/);
  assert.match(md, /\| rule \| findings \| sessions \|/);
  assert.match(md, /\| block-loop \| 2 \| 2 \|/);
  assert.match(md, /id09/);
  assert.doesNotMatch(md, /id10/);
  assert.match(md, /bad regex dropped/);
});

test('renderMarkdown escapes pipes in summaries', () => {
  const open = [{ id: 'abc', rule: 'r', seen_days: ['d'], examples: [], title: 'a | b' }];
  const md = report.renderMarkdown(sampleReport(), { open });
  assert.match(md, /a \\\| b/);
});

test('writeReport replaces an existing report for the date', () => {
  const env = setup();
  try {
    const first = sampleReport();
    report.writeReport(first, 'one');
    report.writeReport({ ...first, warnings: ['second'] }, 'two');
    const dir = path.join(env.kit, 'data', 'reports');
    assert.equal(fs.readFileSync(path.join(dir, '2026-01-10.md'), 'utf8'), 'two');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '2026-01-10.json'), 'utf8')).warnings, ['second']);
  } finally {
    env.restore();
  }
});

test('loadDailyReports: the newest report wins per day', () => {
  const env = setup();
  try {
    const dir = path.join(env.kit, 'data', 'reports');
    fs.mkdirSync(dir, { recursive: true });
    const row = (n) => ({ k: { hitSessions: n, exposedSessions: 5 } });
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ generated_at: '2026-01-12T10:00:00Z', daily: { '2026-01-10': row(1), '2026-01-11': row(9) } }));
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ generated_at: '2026-01-13T10:00:00Z', daily: { '2026-01-10': row(2) } }));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
    const merged = report.loadDailyReports();
    assert.equal(merged['2026-01-10'].k.hitSessions, 2);
    assert.equal(merged['2026-01-11'].k.hitSessions, 9);
  } finally {
    env.restore();
  }
});

test('pruneReports removes reports older than the retention', () => {
  const env = setup();
  try {
    const dir = path.join(env.kit, 'data', 'reports');
    fs.mkdirSync(dir, { recursive: true });
    for (const d of ['2026-01-01', '2026-03-01']) {
      fs.writeFileSync(path.join(dir, `${d}.json`), '{}');
      fs.writeFileSync(path.join(dir, `${d}.md`), '');
    }
    report.pruneReports(30, '2026-03-10');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-03-01.json', '2026-03-01.md']);
  } finally {
    env.restore();
  }
});

const { spawnSync } = require('node:child_process');

const AUDIT = path.join(__dirname, '..', 'scripts', 'audit.js');
const reportDays = (env) => {
  const dir = path.join(env.kit, 'data', 'reports');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort() : [];
};

test('--days 2 audits the last two full days and writes two reports', async () => {
  const env = setup();
  try {
    seed(env, dayBefore(1));
    writeTranscript(env.claude, 'sess-older', [toolUse(dayBefore(2), 0, 'alice-sess-old', 'o0', 'ls'), okResult(dayBefore(2), 1, 'alice-sess-old', 'o0')]);
    writeTranscript(env.claude, 'sess-three', [toolUse(dayBefore(3), 0, 'alice-sess-3', 'x0', 'npm i lodash')]);
    const res = await main(['--days', '2', '--json'], quiet);
    assert.deepEqual(res.days, [localDay(dayBefore(2)), localDay(dayBefore(1))]);
    assert.deepEqual(reportDays(env), res.days);
    const queue = JSON.parse(fs.readFileSync(path.join(env.kit, 'data', 'queue.json'), 'utf8'));
    assert.ok(queue.open.every((i) => !i.seen_days.includes(localDay(dayBefore(3)))));
  } finally {
    env.restore();
  }
});

test('--projects-dir reads that directory instead of the default', async () => {
  const env = setup();
  try {
    const day = dayBefore(1);
    const alt = path.join(env.root, 'alt-claude');
    fs.mkdirSync(alt, { recursive: true });
    writeTranscript(alt, 'sess-alt', [toolUse(day, 0, 'alice-sess-alt', 'a0', 'npm i lodash')]);
    fs.writeFileSync(path.join(env.kit, 'config.json'), JSON.stringify({
      forbidden: [{ id: 'no-npm', tool: '^Bash$', field: 'command', pattern: '(^|\\s)npm\\s+(i|install)\\b' }],
    }));
    const without = await main(['--date', localDay(day), '--json'], quiet);
    assert.equal(without.transcripts, 0);
    const res = await main(['--date', localDay(day), '--json', '--projects-dir', path.join(alt, 'projects')], quiet);
    assert.equal(res.transcripts, 1);
    assert.equal(res.findings, 1);
  } finally {
    env.restore();
  }
});

test('bad arguments exit non-zero with a usage line and write nothing', () => {
  const env = setup();
  try {
    for (const args of [['--days', 'x'], ['--days', '0'], ['--date', '2026-13-45'], ['--date', 'yesterday'], ['--bogus']]) {
      const res = spawnSync(process.execPath, [AUDIT, ...args], {
        encoding: 'utf8',
        env: { ...process.env, HARNESS_AUDIT_KIT_HOME: env.kit, HARNESS_AUDIT_CLAUDE_DIR: env.claude },
      });
      assert.notEqual(res.status, 0, `${args.join(' ')} should fail`);
      assert.match(res.stderr, /usage:/i, args.join(' '));
      assert.ok(!fs.existsSync(path.join(env.kit, 'data')), `${args.join(' ')} wrote data`);
    }
  } finally {
    env.restore();
  }
});

test('--since-last catches up at most 7 days', async () => {
  const env = setup();
  try {
    fs.mkdirSync(path.join(env.kit, 'data'), { recursive: true });
    fs.writeFileSync(path.join(env.kit, 'data', 'state.json'), JSON.stringify({ audited_through: localDay(dayBefore(20)) }));
    const res = await main(['--since-last', '--json'], quiet);
    assert.equal(res.days.length, 7);
    assert.equal(res.days[0], localDay(dayBefore(7)));
    assert.equal(res.days[6], localDay(dayBefore(1)));
    assert.equal(reportDays(env).length, 7);
  } finally {
    env.restore();
  }
});

test('an existing fix ledger is evaluated into efficacy.json', async () => {
  const env = setup();
  try {
    seed(env, dayBefore(3));
    fs.mkdirSync(path.join(env.kit, 'data'), { recursive: true });
    fs.writeFileSync(path.join(env.kit, 'data', 'fix-ledger.json'), JSON.stringify([
      { key: 'block-loop:lint-guard', rule: 'block-loop', date: localDay(dayBefore(2)), note: 'tightened the hook' },
    ]));
    await main(['--days', '3', '--json'], quiet);
    const eff = JSON.parse(fs.readFileSync(path.join(env.kit, 'data', 'efficacy.json'), 'utf8'));
    assert.equal(eff.results.length, 1);
    assert.equal(eff.results[0].key, 'block-loop:lint-guard');
    assert.equal(eff.results[0].before.hits, 1);
    assert.ok(['pending', 'insufficient'].includes(eff.results[0].verdict), eff.results[0].verdict);
    assert.equal(eff.summary.tracked, 1);
  } finally {
    env.restore();
  }
});

test('ignoreProjects skips the matching project dir and keeps others', async () => {
  const env = setup();
  try {
    const day = dayBefore(1);
    seed(env, day);
    const other = path.join(env.claude, 'projects', '-Users-alice-dev-other');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 's.jsonl'), `${JSON.stringify(toolUse(day, 0, 'alice-sess-other', 'z0', 'npm i lodash'))}\n`);
    const cfg = path.join(env.kit, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), ignoreProjects: ['acme'] }));
    const res = await main(['--date', localDay(day), '--json'], quiet);
    assert.equal(res.transcripts, 1);
    assert.equal(res.findings, 1);
  } finally {
    env.restore();
  }
});

const hookRun = (day, sec, session, stderr = '') => ({ type: 'attachment', sessionId: session, timestamp: stamp(day, sec),
  attachment: { type: 'hook_success', hookName: 'PreToolUse:Bash', command: 'node /home/alice/hooks/lint-guard.js', stderr, durationMs: 5 } });
const userSays = (day, sec, session, text) => ({ type: 'user', sessionId: session, timestamp: stamp(day, sec), message: { content: text } });
const readReport = (env, date) => JSON.parse(fs.readFileSync(path.join(env.kit, 'data', 'reports', `${date}.json`), 'utf8'));

test('hook-error exposure is every session that ran the hook (1 crash + 4 clean = 5)', async () => {
  const env = setup();
  try {
    const day = dayBefore(1);
    for (let i = 0; i < 5; i += 1) {
      writeTranscript(env.claude, `s${i}`, [hookRun(day, 0, `alice-${i}-sess`, i === 0 ? 'TypeError: x is not a function' : '')]);
    }
    await main(['--date', localDay(day), '--json'], quiet);
    assert.deepEqual(readReport(env, localDay(day)).daily[localDay(day)]['hook-error:lint-guard'], { hitSessions: 1, exposedSessions: 5 });
  } finally {
    env.restore();
  }
});

test('user-correction exposure is every session of the day', async () => {
  const env = setup();
  try {
    const day = dayBefore(1);
    writeTranscript(env.claude, 'c0', [userSays(day, 0, 'alice-0-sess', 'no, that is wrong')]);
    for (let i = 1; i < 4; i += 1) writeTranscript(env.claude, `c${i}`, [toolUse(day, 0, `alice-${i}-sess`, `c${i}`, 'ls')]);
    await main(['--date', localDay(day), '--json'], quiet);
    assert.deepEqual(readReport(env, localDay(day)).daily[localDay(day)]['user-correction:any'], { hitSessions: 1, exposedSessions: 4 });
  } finally {
    env.restore();
  }
});

test('a ledger key gets a row on a day with no hit and no exposure', async () => {
  const env = setup();
  try {
    const day = dayBefore(1);
    fs.mkdirSync(path.join(env.kit, 'data'), { recursive: true });
    fs.writeFileSync(path.join(env.kit, 'data', 'fix-ledger.json'), JSON.stringify([{ key: 'block-loop:lint-guard', rule: 'block-loop', date: localDay(dayBefore(5)), note: 'n' }]));
    await main(['--date', localDay(day), '--json'], quiet);
    assert.deepEqual(readReport(env, localDay(day)).daily[localDay(day)]['block-loop:lint-guard'], { hitSessions: 0, exposedSessions: 0 });
  } finally {
    env.restore();
  }
});

test('a corrupt queue is moved aside, the audit starts empty and says so', async () => {
  const env = setup();
  try {
    const day = dayBefore(1);
    seed(env, day);
    fs.mkdirSync(path.join(env.kit, 'data'), { recursive: true });
    fs.writeFileSync(path.join(env.kit, 'data', 'queue.json'), '{nope');
    await main(['--date', localDay(day), '--json'], quiet);
    const names = fs.readdirSync(path.join(env.kit, 'data'));
    assert.ok(names.some((n) => n.startsWith('queue.json.corrupt-')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(env.kit, 'data', 'queue.json'), 'utf8')).open.length, 2);
    assert.ok(readReport(env, localDay(day)).warnings.some((w) => /queue\.json was unreadable/.test(w)));
  } finally {
    env.restore();
  }
});

test('state written by another process during the run is not lost', async () => {
  const env = setup();
  const original = report.writeReport;
  try {
    const day = dayBefore(1);
    fs.mkdirSync(path.join(env.kit, 'data'), { recursive: true });
    report.writeReport = (...args) => {
      fs.writeFileSync(path.join(env.kit, 'data', 'state.json'), JSON.stringify({ owner: 'hook', audited_through: '2000-01-01' }));
      return original(...args);
    };
    await main(['--date', localDay(day), '--json'], quiet);
    const state = JSON.parse(fs.readFileSync(path.join(env.kit, 'data', 'state.json'), 'utf8'));
    assert.equal(state.owner, 'hook');
    assert.equal(state.audited_through, localDay(day));
  } finally {
    report.writeReport = original;
    env.restore();
  }
});

test('report warnings are redacted', () => {
  const rep = report.buildReport({ date: '2026-01-10', window: {}, warnings: ['cannot read /Users/alice/.claude/harness-audit-kit/config.json: EACCES'] });
  assert.ok(!rep.warnings.join('').includes('/Users/alice'));
  assert.match(rep.warnings[0], /<home>|~/);
});

test('efficacy history survives the report prune', () => {
  const env = setup();
  try {
    const row = (n) => ({ 'block-loop:lint-guard': { hitSessions: n, exposedSessions: 4 } });
    for (const [date, n] of [['2026-01-01', 3], ['2026-03-01', 1]]) {
      report.writeReport(report.buildReport({ date, window: {}, daily: { [date]: row(n) } }), 'md');
    }
    const before = report.loadDailyReports();
    report.pruneReports(30, '2026-03-10');
    assert.ok(!fs.existsSync(path.join(env.kit, 'data', 'reports', '2026-01-01.json')));
    assert.deepEqual(report.loadDailyReports(), before);
    assert.equal(report.loadDailyReports()['2026-01-01']['block-loop:lint-guard'].hitSessions, 3);
  } finally {
    env.restore();
  }
});

test('--date today or later is a usage error and writes nothing', async () => {
  const env = setup();
  try {
    for (const n of [0, -1, -30]) {
      await assert.rejects(main(['--date', localDay(dayBefore(n))], quiet), (err) => err.usage === true && /before today/.test(err.message));
    }
    assert.ok(!fs.existsSync(path.join(env.kit, 'data')));
  } finally {
    env.restore();
  }
});

test('days are local days: a UTC+14 session at 11:30Z lands on the next calendar day', () => {
  const env = setup();
  try {
    fs.writeFileSync(path.join(env.kit, 'config.json'), JSON.stringify({
      forbidden: [{ id: 'no-npm', tool: '^Bash$', field: 'command', pattern: '(^|\\s)npm\\s+(i|install)\\b' }],
    }));
    const line = { type: 'assistant', sessionId: 'alice-tz-sess', timestamp: '2026-03-10T11:30:00.000Z',
      message: { id: 'm1', content: [{ type: 'tool_use', id: 'tz0', name: 'Bash', input: { command: 'npm i lodash' } }] } };
    writeTranscript(env.claude, 'tz', [line]);
    const run = (date) => {
      const res = spawnSync(process.execPath, [AUDIT, '--date', date, '--json'], {
        encoding: 'utf8',
        env: { ...process.env, TZ: 'Pacific/Kiritimati', HARNESS_AUDIT_KIT_HOME: env.kit, HARNESS_AUDIT_CLAUDE_DIR: env.claude },
      });
      assert.equal(res.status, 0, res.stderr);
      return JSON.parse(res.stdout.trim().split('\n').pop());
    };
    assert.equal(run('2026-03-10').findings, 0);
    assert.deepEqual(reportDays(env), ['2026-03-10']);
    assert.equal(readReport(env, '2026-03-10').findings.length, 0);
    assert.equal(run('2026-03-11').findings, 1);
    assert.ok(reportDays(env).includes('2026-03-11'));
    assert.equal(readReport(env, '2026-03-11').findings.length, 1);
  } finally {
    env.restore();
  }
});

test('a hook whose name holds a token gets matching hit and exposure rows under one redacted key', async () => {
  const env = setup();
  try {
    const day = dayBefore(1);
    const fake = ['sk', 'ant', 'abcdefghijklmnop1234'].join('-');
    const run = (sec, session, stderr) => ({ type: 'attachment', sessionId: session, timestamp: stamp(day, sec),
      attachment: { type: 'hook_success', hookName: 'PreToolUse:Bash', command: `node /home/alice/hooks/lint-${fake}.js`, stderr, durationMs: 5 } });
    writeTranscript(env.claude, 'k0', [run(0, 'alice-0-sess', 'TypeError: x is not a function')]);
    writeTranscript(env.claude, 'k1', [run(0, 'alice-1-sess', '')]);
    writeTranscript(env.claude, 'k2', [run(0, 'alice-2-sess', '')]);
    await main(['--date', localDay(day), '--json'], quiet);
    const rep = readReport(env, localDay(day));
    const rows = Object.entries(rep.daily[localDay(day)]).filter(([k]) => k.startsWith('hook-error:'));
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0][1], { hitSessions: 1, exposedSessions: 3 });
    assert.ok(!JSON.stringify(rep).includes(fake));
  } finally {
    env.restore();
  }
});

test('a --date run older than retentionDays keeps the report it just wrote', async () => {
  const env = setup();
  try {
    const old = dayBefore(70);
    fs.mkdirSync(path.join(env.kit, 'data', 'reports'), { recursive: true });
    fs.writeFileSync(path.join(env.kit, 'data', 'reports', '2020-01-01.json'), '{}');
    fs.writeFileSync(path.join(env.kit, 'data', 'reports', '2020-01-01.md'), '');
    writeTranscript(env.claude, 'old', [toolUse(old, 0, 'alice-old-sess', 'ol0', 'ls')]);
    await main(['--date', localDay(old), '--json'], quiet);
    assert.ok(fs.existsSync(path.join(env.kit, 'data', 'reports', `${localDay(old)}.json`)));
    assert.ok(fs.existsSync(path.join(env.kit, 'data', 'reports', `${localDay(old)}.md`)));
    assert.ok(!fs.existsSync(path.join(env.kit, 'data', 'reports', '2020-01-01.json')), 'other old reports are still pruned');
  } finally {
    env.restore();
  }
});

const installHook = (env) => fs.writeFileSync(path.join(env.claude, 'settings.json'), JSON.stringify({
  hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node /home/alice/hooks/lint-guard.js' }] }] },
}));

function sessionLoop(env, name, day, session, blocked) {
  const events = [];
  const calls = blocked ? 3 : 1;
  for (let i = 0; i < calls; i += 1) {
    const id = `${name}-${i}`;
    events.push(toolUse(day, i * 2, session, id, `pnpm lint ${i}`));
    events.push(blocked ? blockResult(day, i * 2 + 1, session, id) : okResult(day, i * 2 + 1, session, id));
  }
  writeTranscript(env.claude, name, events);
}

test('a fix that stops an installed hook from blocking is judged effective, not insufficient', async () => {
  const env = setup();
  try {
    installHook(env);
    for (let back = 1; back <= 8; back += 1) {
      for (let s = 0; s < 5; s += 1) {
        const blocked = back >= 5 && s < 4;
        sessionLoop(env, `d${back}s${s}`, dayBefore(back), `d${back}s${s}-alice`, blocked);
      }
    }
    fs.mkdirSync(path.join(env.kit, 'data'), { recursive: true });
    fs.writeFileSync(path.join(env.kit, 'data', 'fix-ledger.json'), JSON.stringify([
      { key: 'block-loop:lint-guard', rule: 'block-loop', date: localDay(dayBefore(4)), note: 'fixed the hook' },
    ]));
    await main(['--days', '8', '--json'], quiet);
    const eff = JSON.parse(fs.readFileSync(path.join(env.kit, 'data', 'efficacy.json'), 'utf8'));
    assert.equal(eff.results[0].before.hits, 16);
    assert.equal(eff.results[0].after.exposed, 15);
    assert.equal(eff.results[0].verdict, 'effective');
  } finally {
    env.restore();
  }
});

test('a silent installed hook with no attachments is exposed to every session of the day', async () => {
  const env = setup();
  try {
    installHook(env);
    const day = dayBefore(1);
    for (let i = 0; i < 3; i += 1) sessionLoop(env, `q${i}`, day, `alice-q${i}-sess`, false);
    fs.mkdirSync(path.join(env.kit, 'data'), { recursive: true });
    fs.writeFileSync(path.join(env.kit, 'data', 'fix-ledger.json'), JSON.stringify([
      { key: 'hook-error:lint-guard', rule: 'hook-error', date: localDay(dayBefore(5)), note: 'n' },
    ]));
    await main(['--date', localDay(day), '--json'], quiet);
    assert.deepEqual(readReport(env, localDay(day)).daily[localDay(day)]['hook-error:lint-guard'], { hitSessions: 0, exposedSessions: 3 });
  } finally {
    env.restore();
  }
});

test('a hook missing from settings is exposed only to sessions that hit it or ran it', async () => {
  const env = setup();
  try {
    const day = dayBefore(1);
    for (let i = 0; i < 3; i += 1) sessionLoop(env, `p${i}`, day, `alice-p${i}-sess`, i === 0);
    await main(['--date', localDay(day), '--json'], quiet);
    assert.deepEqual(readReport(env, localDay(day)).daily[localDay(day)]['block-loop:lint-guard'], { hitSessions: 1, exposedSessions: 1 });
  } finally {
    env.restore();
  }
});

test('tool-error-loop exposure is the sessions that used that tool that day', async () => {
  const env = setup();
  try {
    const day = dayBefore(1);
    const failing = [];
    for (let i = 0; i < 3; i += 1) {
      failing.push(toolUse(day, i * 2, 'alice-t0-sess', `te${i}`, `make build ${i}`));
      failing.push({ type: 'user', sessionId: 'alice-t0-sess', timestamp: stamp(day, i * 2 + 1),
        message: { content: [{ type: 'tool_result', tool_use_id: `te${i}`, is_error: true, content: 'Error: build exploded' }] } });
    }
    writeTranscript(env.claude, 't0', failing);
    for (let i = 1; i < 4; i += 1) sessionLoop(env, `t${i}`, day, `alice-t${i}-sess`, false);
    writeTranscript(env.claude, 'tother', [{ type: 'assistant', sessionId: 'alice-tother', timestamp: stamp(day, 0),
      message: { id: 'mo', content: [{ type: 'tool_use', id: 'ro', name: 'Read', input: {} }] } }]);
    await main(['--date', localDay(day), '--json'], quiet);
    assert.deepEqual(readReport(env, localDay(day)).daily[localDay(day)]['tool-error-loop:Bash'], { hitSessions: 1, exposedSessions: 4 });
  } finally {
    env.restore();
  }
});

test('a queue that cannot be read aborts the audit and is left in place', async () => {
  const env = setup();
  try {
    seed(env, dayBefore(1));
    const queue = path.join(env.kit, 'data', 'queue.json');
    fs.mkdirSync(queue, { recursive: true });
    await assert.rejects(main(['--date', localDay(dayBefore(1)), '--json'], quiet), (err) => err.code === 'EISDIR');
    assert.ok(fs.statSync(queue).isDirectory());
    assert.ok(!fs.readdirSync(path.join(env.kit, 'data')).some((n) => n.includes('.corrupt-')));
  } finally {
    env.restore();
  }
});

test('re-auditing a day whose transcripts are gone keeps its daily-index entry', async () => {
  const env = setup();
  try {
    const day = dayBefore(1);
    seed(env, day);
    await main(['--date', localDay(day), '--json'], quiet);
    const index = () => JSON.parse(fs.readFileSync(path.join(env.kit, 'data', 'daily-index.json'), 'utf8'));
    const before = index()[localDay(day)];
    assert.equal(before['block-loop:lint-guard'].hitSessions, 1);
    fs.rmSync(path.join(env.claude, 'projects'), { recursive: true, force: true });
    const again = await main(['--date', localDay(day), '--json'], quiet);
    assert.equal(again.transcripts, 0);
    assert.deepEqual(index()[localDay(day)], before);
    assert.deepEqual(report.loadDailyReports()[localDay(day)], before);
  } finally {
    env.restore();
  }
});

const readQueue = (env) => JSON.parse(fs.readFileSync(path.join(env.kit, 'data', 'queue.json'), 'utf8'));
const readState = (env) => JSON.parse(fs.readFileSync(path.join(env.kit, 'data', 'state.json'), 'utf8'));
const metricsIndex = (env) => JSON.parse(fs.readFileSync(path.join(env.kit, 'data', 'metrics-index.json'), 'utf8'));
const versioned = (version, ev) => ({ ...ev, version });

test('the report carries per-day outcome metrics and the metrics index keeps them', async () => {
  const env = setup();
  try {
    const day = dayBefore(1);
    const date = localDay(day);
    seed(env, day);
    await main(['--date', date, '--json'], quiet);
    const m = readReport(env, date).metrics[date];
    assert.equal(m.sessions, 2);
    assert.equal(m.tool_calls, 4);
    assert.equal(m.blocks, 3);
    assert.equal(m.blocks_per_100_calls, 75);
    assert.equal(m.tool_calls_per_session, 2);
    assert.deepEqual(metricsIndex(env)[date], m);
    assert.deepEqual(report.loadMetrics()[date], m);
  } finally {
    env.restore();
  }
});

test('re-auditing a day whose transcripts are gone keeps its metrics, and the prune leaves the index alone', async () => {
  const env = setup();
  try {
    const day = dayBefore(1);
    const date = localDay(day);
    seed(env, day);
    await main(['--date', date, '--json'], quiet);
    const before = metricsIndex(env)[date];
    fs.rmSync(path.join(env.claude, 'projects'), { recursive: true, force: true });
    await main(['--date', date, '--json'], quiet);
    assert.deepEqual(metricsIndex(env)[date], before);
    report.pruneReports(1, '2030-01-01');
    assert.deepEqual(metricsIndex(env)[date], before);
  } finally {
    env.restore();
  }
});

test('user corrections and interrupts in the metrics come from the detectors, not from a second regex', async () => {
  const env = setup();
  try {
    const day = dayBefore(1);
    const date = localDay(day);
    writeTranscript(env.claude, 'c0', [userSays(day, 0, 'alice-0-sess', 'no, that is wrong'), toolUse(day, 1, 'alice-0-sess', 'c00', 'ls')]);
    writeTranscript(env.claude, 'c1', [userSays(day, 0, 'alice-1-sess', 'looks good, thanks')]);
    await main(['--date', date, '--json'], quiet);
    const m = readReport(env, date).metrics[date];
    assert.equal(m.corrections, 1);
    assert.equal(m.corrections_per_session, 0.5);
  } finally {
    env.restore();
  }
});

test('a CLI version change across two audits queues exactly one low finding', async () => {
  const env = setup();
  try {
    const older = dayBefore(2);
    const newer = dayBefore(1);
    writeTranscript(env.claude, 'v1', [versioned('2.1.300', toolUse(older, 0, 'alice-v1-sess', 'v10', 'ls'))]);
    await main(['--date', localDay(older), '--json'], quiet);
    assert.equal(readState(env).last_version, '2.1.300');
    assert.deepEqual(readQueue(env).open.filter((i) => i.rule === 'claude-version-changed'), []);

    writeTranscript(env.claude, 'v2', [versioned('2.1.301', toolUse(newer, 0, 'alice-v2-sess', 'v20', 'ls'))]);
    await main(['--date', localDay(newer), '--json'], quiet);
    const found = readQueue(env).open.filter((i) => i.rule === 'claude-version-changed');
    assert.equal(found.length, 1);
    assert.equal(found[0].key, 'claude-version-changed:2.1.301');
    assert.equal(found[0].severity, 'low');
    assert.equal(found[0].title, 'CLI version 2.1.300 → 2.1.301: re-run your hook tests');
    assert.equal(readState(env).last_version, '2.1.301');

    await main(['--date', localDay(newer), '--json'], quiet);
    assert.equal(readQueue(env).open.filter((i) => i.rule === 'claude-version-changed').length, 1);
    assert.equal(readQueue(env).open.find((i) => i.rule === 'claude-version-changed').hits, 1);
  } finally {
    env.restore();
  }
});

test('re-auditing an older day does not look like a version change back', async () => {
  const env = setup();
  try {
    const older = dayBefore(2);
    const newer = dayBefore(1);
    writeTranscript(env.claude, 'v1', [versioned('2.1.300', toolUse(older, 0, 'alice-v1-sess', 'v10', 'ls'))]);
    writeTranscript(env.claude, 'v2', [versioned('2.1.301', toolUse(newer, 0, 'alice-v2-sess', 'v20', 'ls'))]);
    await main(['--date', localDay(older), '--json'], quiet);
    await main(['--date', localDay(newer), '--json'], quiet);
    await main(['--date', localDay(older), '--json'], quiet);
    assert.equal(readState(env).last_version, '2.1.301');
    assert.deepEqual(readQueue(env).open.map((i) => i.key).filter((k) => k.startsWith('claude-version-changed')), ['claude-version-changed:2.1.301']);
  } finally {
    env.restore();
  }
});

test('an outcome regression over the merged metrics index reaches the queue', async () => {
  const env = setup();
  try {
    const raw = (blocks) => ({ sessions: 2, tool_calls: 100, blocks, retries: 0, tool_errors: 0, corrections: 0, interrupts: 0 });
    const seeded = {};
    for (let back = 14; back >= 2; back -= 1) seeded[localDay(dayBefore(back))] = raw(back >= 8 ? 2 : 5);
    fs.mkdirSync(path.join(env.kit, 'data'), { recursive: true });
    fs.writeFileSync(path.join(env.kit, 'data', 'metrics-index.json'), JSON.stringify(seeded));
    seed(env, dayBefore(1));
    await main(['--date', localDay(dayBefore(1)), '--json'], quiet);
    const item = readQueue(env).open.find((i) => i.key === 'outcome-regression:blocks_per_100_calls');
    assert.ok(item, readQueue(env).open.map((i) => i.key).join(','));
    assert.equal(item.severity, 'medium');
    assert.match(item.title, /blocks per 100 tool calls/);
  } finally {
    env.restore();
  }
});

test('the trend thresholds come from config.outcome', async () => {
  const env = setup();
  try {
    const raw = (blocks) => ({ sessions: 2, tool_calls: 100, blocks, retries: 0, tool_errors: 0, corrections: 0, interrupts: 0 });
    const seeded = {};
    for (let back = 14; back >= 2; back -= 1) seeded[localDay(dayBefore(back))] = raw(back >= 8 ? 2 : 5);
    fs.mkdirSync(path.join(env.kit, 'data'), { recursive: true });
    fs.writeFileSync(path.join(env.kit, 'data', 'metrics-index.json'), JSON.stringify(seeded));
    seed(env, dayBefore(1));
    const cfg = path.join(env.kit, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), outcome: { minSessions: 50 } }));
    await main(['--date', localDay(dayBefore(1)), '--json'], quiet);
    assert.ok(!readQueue(env).open.some((i) => i.rule === 'outcome-regression'));
  } finally {
    env.restore();
  }
});

test('a first audit of an empty day still records the day in the index', async () => {
  const env = setup();
  try {
    const day = localDay(dayBefore(1));
    await main(['--date', day, '--json'], quiet);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.kit, 'data', 'daily-index.json'), 'utf8'))[day], {});
  } finally {
    env.restore();
  }
});

test('agent-usage-limit exposure is every session of the day (1 limit + 4 clean = 5)', async () => {
  const env = setup();
  try {
    const day = dayBefore(1);
    const limit = { type: 'user', sessionId: 'alice-0-sess', timestamp: stamp(day, 0),
      message: { content: [{ type: 'tool_result', tool_use_id: 'lm0', is_error: true, content: "You've reached your opus limit" }] } };
    writeTranscript(env.claude, 'lim0', [limit]);
    for (let i = 1; i < 5; i += 1) writeTranscript(env.claude, `lim${i}`, [toolUse(day, 0, `alice-${i}-sess`, `lm${i}`, 'ls')]);
    await main(['--date', localDay(day), '--json'], quiet);
    assert.deepEqual(readReport(env, localDay(day)).daily[localDay(day)]['agent-usage-limit:opus'], { hitSessions: 1, exposedSessions: 5 });
  } finally {
    env.restore();
  }
});

test('every rule has an exposure path in buildDaily or the n/a path in efficacy', () => {
  const { IDS } = require('../scripts/lib/detectors');
  const { AUDIT_LEVEL_RULES } = require('../scripts/lib/efficacy');
  const { exposureModel } = require('../scripts/audit');
  const MODELS = ['all-sessions', 'hook', 'tool', 'detector', 'n/a'];
  for (const rule of [...IDS, ...AUDIT_LEVEL_RULES]) {
    assert.ok(MODELS.includes(exposureModel(rule)), `${rule} has no exposure model`);
  }
  assert.equal(exposureModel('agent-usage-limit'), 'all-sessions');
  assert.equal(exposureModel('outcome-regression'), 'n/a');
  assert.equal(exposureModel('not-a-rule'), null);
});
