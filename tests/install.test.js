'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const install = require('../install');
const uninstall = require('../uninstall');

const ENV_KEYS = ['HARNESS_AUDIT_CLAUDE_DIR', 'CLAUDE_CONFIG_DIR', 'HARNESS_AUDIT_KIT_HOME'];
const MARKER = 'harness-audit-start.js';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function makeRepo() {
  const repo = tmp('kit-repo');
  const write = (rel, body) => {
    const file = path.join(repo, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  write('hooks/harness-audit-start.js', '// stub\n');
  write('scripts/status.js', '// stub\n');
  write('scripts/lib/paths.js', '// stub\n');
  write('config.example.json', '{"example":true}\n');
  write('rules/harness-audit.md', '# rule\n');
  write('tests/secret.test.js', '// must not be copied\n');
  write('.task/notes.md', 'must not be copied\n');
  write('.git/HEAD', 'ref\n');
  return repo;
}

function setup(envKey = 'HARNESS_AUDIT_CLAUDE_DIR') {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  const claude = tmp('kit-claude');
  process.env[envKey] = claude;
  const repo = makeRepo();
  const lines = [];
  const opts = { out: (s) => lines.push(String(s)), repoDir: repo };
  const settings = path.join(claude, 'settings.json');
  const kit = path.join(claude, 'harness-audit-kit');
  const restore = () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(claude, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  };
  return { claude, repo, opts, lines, settings, kit, restore };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const ours = (settings) => (settings.hooks.SessionStart || [])
  .flatMap((g) => g.hooks).filter((h) => h.command.includes(MARKER));

const OTHER = {
  hooks: {
    SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo alice' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node lint-guard.js' }] }],
  },
  theme: 'dark',
};

test('install keeps other hooks and keys, adds one entry without matcher', () => {
  const t = setup();
  try {
    fs.writeFileSync(t.settings, JSON.stringify(OTHER));
    assert.equal(install.main([], t.opts), 0);
    const s = readJson(t.settings);
    assert.equal(s.theme, 'dark');
    assert.deepEqual(s.hooks.PreToolUse, OTHER.hooks.PreToolUse);
    assert.deepEqual(s.hooks.SessionStart[0], OTHER.hooks.SessionStart[0]);
    const mine = ours(s);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].timeout, 10);
    assert.equal(mine[0].command, `node "${path.join(t.kit, 'hooks', MARKER)}"`);
    const group = s.hooks.SessionStart.find((g) => g.hooks.includes(mine[0]));
    assert.equal('matcher' in group, false);
    assert.ok(fs.readFileSync(t.settings, 'utf8').endsWith('}\n'));
  } finally { t.restore(); }
});

test('install copies kit code and rule, never tests/.git/.task', () => {
  const t = setup();
  try {
    assert.equal(install.main([], t.opts), 0);
    assert.ok(fs.existsSync(path.join(t.kit, 'hooks', MARKER)));
    assert.ok(fs.existsSync(path.join(t.kit, 'scripts', 'lib', 'paths.js')));
    assert.ok(fs.existsSync(path.join(t.kit, 'config.example.json')));
    assert.ok(fs.existsSync(path.join(t.claude, 'rules', 'harness-audit.md')));
    for (const bad of ['tests', '.git', '.task']) assert.equal(fs.existsSync(path.join(t.kit, bad)), false);
    assert.deepEqual(readJson(path.join(t.kit, 'config.json')), { example: true });
  } finally { t.restore(); }
});

test('second install leaves exactly one of our entries and backs up settings', () => {
  const t = setup();
  try {
    install.main([], t.opts);
    install.main([], t.opts);
    assert.equal(ours(readJson(t.settings)).length, 1);
    const backups = fs.readdirSync(t.claude).filter((f) => /^settings\.json\.bak-\d{8}-\d{6}-\d{3}(-\d+)?$/.test(f));
    assert.ok(backups.length >= 1);
  } finally { t.restore(); }
});

test('an older entry of ours is replaced, not duplicated', () => {
  const t = setup();
  try {
    const old = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node "/old/place/${MARKER}"`, timeout: 3 }, { type: 'command', command: 'echo keep' }] }] } };
    fs.writeFileSync(t.settings, JSON.stringify(old));
    install.main([], t.opts);
    const s = readJson(t.settings);
    assert.equal(ours(s).length, 1);
    assert.ok(ours(s)[0].command.includes(t.kit));
    assert.ok(s.hooks.SessionStart.flatMap((g) => g.hooks).some((h) => h.command === 'echo keep'));
  } finally { t.restore(); }
});

test('invalid settings JSON aborts with exit 1 and leaves bytes unchanged', () => {
  const t = setup();
  try {
    const bytes = '{ "hooks": [ broken';
    fs.writeFileSync(t.settings, bytes);
    assert.equal(install.main([], t.opts), 1);
    assert.equal(fs.readFileSync(t.settings, 'utf8'), bytes);
    assert.equal(fs.readdirSync(t.claude).some((f) => f.includes('.bak-')), false);
  } finally { t.restore(); }
});

test('existing config.json is not overwritten', () => {
  const t = setup();
  try {
    fs.mkdirSync(t.kit, { recursive: true });
    fs.writeFileSync(path.join(t.kit, 'config.json'), '{"mine":1}');
    install.main([], t.opts);
    assert.equal(fs.readFileSync(path.join(t.kit, 'config.json'), 'utf8'), '{"mine":1}');
  } finally { t.restore(); }
});

test('CLAUDE_CONFIG_DIR is honoured when HARNESS_AUDIT_CLAUDE_DIR is unset', () => {
  const t = setup('CLAUDE_CONFIG_DIR');
  try {
    assert.equal(process.env.HARNESS_AUDIT_CLAUDE_DIR, undefined);
    assert.equal(install.main([], t.opts), 0);
    assert.ok(fs.existsSync(t.settings));
    assert.ok(fs.existsSync(path.join(t.kit, 'hooks', MARKER)));
  } finally { t.restore(); }
});

test('--dry-run writes nothing', () => {
  const t = setup();
  try {
    assert.equal(install.main(['--dry-run'], t.opts), 0);
    assert.deepEqual(fs.readdirSync(t.claude), []);
    assert.ok(t.lines.join('\n').length > 0);
  } finally { t.restore(); }
});

test('old Node major exits 1', () => {
  const t = setup();
  try {
    assert.equal(install.main([], { ...t.opts, nodeMajor: 16 }), 1);
    assert.deepEqual(fs.readdirSync(t.claude), []);
  } finally { t.restore(); }
});

test('missing rule file warns and continues', () => {
  const t = setup();
  try {
    fs.rmSync(path.join(t.repo, 'rules'), { recursive: true });
    assert.equal(install.main([], t.opts), 0);
    assert.match(t.lines.join('\n'), /warn/i);
  } finally { t.restore(); }
});

test('uninstall removes only our entry and the rule, keeps data', () => {
  const t = setup();
  try {
    fs.writeFileSync(t.settings, JSON.stringify(OTHER));
    install.main([], t.opts);
    fs.mkdirSync(path.join(t.kit, 'data'), { recursive: true });
    fs.writeFileSync(path.join(t.kit, 'data', 'state.json'), '{}');
    assert.equal(uninstall.main([], t.opts), 0);
    const s = readJson(t.settings);
    assert.deepEqual(s.hooks, OTHER.hooks);
    assert.equal(s.theme, 'dark');
    assert.equal(fs.existsSync(path.join(t.claude, 'rules', 'harness-audit.md')), false);
    assert.equal(fs.existsSync(path.join(t.kit, 'hooks')), false);
    assert.equal(fs.existsSync(path.join(t.kit, 'scripts')), false);
    assert.ok(fs.existsSync(path.join(t.kit, 'data', 'state.json')));
    assert.ok(fs.existsSync(path.join(t.kit, 'config.json')));
  } finally { t.restore(); }
});

test('uninstall drops empty groups and an empty SessionStart', () => {
  const t = setup();
  try {
    install.main([], t.opts);
    uninstall.main([], t.opts);
    const s = readJson(t.settings);
    assert.equal('SessionStart' in (s.hooks || {}), false);
  } finally { t.restore(); }
});

test('uninstall --purge removes the whole kit dir', () => {
  const t = setup();
  try {
    install.main([], t.opts);
    fs.mkdirSync(path.join(t.kit, 'data'), { recursive: true });
    assert.equal(uninstall.main(['--purge'], t.opts), 0);
    assert.equal(fs.existsSync(t.kit), false);
  } finally { t.restore(); }
});

test('uninstall aborts on invalid settings JSON without touching files', () => {
  const t = setup();
  try {
    install.main([], t.opts);
    fs.writeFileSync(t.settings, '{ nope');
    assert.equal(uninstall.main([], t.opts), 1);
    assert.equal(fs.readFileSync(t.settings, 'utf8'), '{ nope');
    assert.ok(fs.existsSync(path.join(t.claude, 'rules', 'harness-audit.md')));
  } finally { t.restore(); }
});

test('hookCommand on win32 uses forward slashes and keeps the quotes', () => {
  const cmd = install.hookCommand('C:\\Users\\alice\\.claude\\harness-audit-kit', 'win32');
  assert.equal(cmd.includes('\\'), false);
  assert.match(cmd, /^node "C:\/Users\/alice\/\.claude\/harness-audit-kit\/hooks\/harness-audit-start\.js"$/);
});

test('hookCommand keeps a kit path with a space quoted on every platform', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const cmd = install.hookCommand('/home/alice smith/.claude/harness-audit-kit', platform);
    assert.ok(cmd.startsWith('node "') && cmd.endsWith('hooks/harness-audit-start.js"'), `${platform}: ${cmd}`);
    assert.ok(cmd.includes('alice smith'));
  }
});

const BAD_SHAPES = {
  'string hooks': { hooks: 'node x.js' },
  'array hooks': { hooks: [] },
  'object SessionStart': { hooks: { SessionStart: {} } },
  'string group hooks': { hooks: { SessionStart: [{ hooks: 'node x.js' }] } },
};

for (const [label, shape] of Object.entries(BAD_SHAPES)) {
  test(`F7: ${label} aborts with exit 1, settings and kit untouched`, () => {
    const t = setup();
    try {
      const bytes = JSON.stringify(shape);
      fs.writeFileSync(t.settings, bytes);
      assert.equal(install.main([], t.opts), 1);
      assert.equal(fs.readFileSync(t.settings, 'utf8'), bytes);
      assert.deepEqual(fs.readdirSync(t.claude), ['settings.json']);
    } finally { t.restore(); }
  });
}

test('F7: two backups in the same millisecond never overwrite each other', () => {
  const t = setup();
  try {
    fs.writeFileSync(t.settings, '{"first":1}');
    const realNow = Date.now;
    const fixed = new Date(2026, 0, 2, 3, 4, 5, 6);
    const RealDate = Date;
    global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed.getTime()])); } };
    let a; let b;
    try {
      a = install.backupSettings(t.settings);
      fs.writeFileSync(t.settings, '{"second":2}');
      b = install.backupSettings(t.settings);
    } finally { global.Date = RealDate; Date.now = realNow; }
    assert.notEqual(a, b);
    assert.equal(fs.readFileSync(a, 'utf8'), '{"first":1}');
    assert.equal(fs.readFileSync(b, 'utf8'), '{"second":2}');
  } finally { t.restore(); }
});

test('F7: settings are written through a tmp file and a symlink survives', () => {
  const t = setup();
  try {
    const real = path.join(t.repo, 'dotfiles-settings.json');
    fs.writeFileSync(real, '{"theme":"dark"}');
    fs.symlinkSync(real, t.settings);
    assert.equal(install.main([], t.opts), 0);
    assert.ok(fs.lstatSync(t.settings).isSymbolicLink());
    assert.equal(readJson(real).theme, 'dark');
    assert.equal(ours(readJson(real)).length, 1);
    assert.equal(fs.readdirSync(t.claude).some((f) => f.includes('.tmp-')), false);
    assert.equal(fs.readdirSync(t.repo).some((f) => f.includes('.tmp-')), false);
  } finally { t.restore(); }
});
