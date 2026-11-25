'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DEFAULTS, mergeConfig, loadConfig } = require('../scripts/lib/config');

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hak-'));
  const file = path.join(dir, 'config.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

test('DEFAULTS has the documented shape', () => {
  assert.equal(DEFAULTS.enabledDetectors.length, 8);
  assert.deepEqual(DEFAULTS.thresholds, { blockLoop: 3, toolErrorLoop: 3 });
  assert.deepEqual(DEFAULTS.inject, { maxItems: 5, maxChars: 4000 });
  assert.deepEqual(DEFAULTS.queue, { expireDays: 14 });
  assert.equal(DEFAULTS.retentionDays, 60);
  assert.deepEqual(DEFAULTS.judge, { enabled: false, model: 'haiku' });
  assert.equal(DEFAULTS.projectsDir, null);
});

test('default phrases compile with flags iu and cover seven languages', () => {
  for (const src of [...DEFAULTS.correctionPhrases, ...DEFAULTS.grantPhrases]) {
    assert.doesNotThrow(() => new RegExp(src, 'iu'), src);
  }
  const hit = (list, text) => list.some((s) => new RegExp(s, 'iu').test(text));
  const corrections = [
    'No, not that', 'I already told you', "that's wrong", 'why did you do that', "don't do that",
    'нет, не то', 'я же сказал', 'зачем ты это сделал', 'я ж казав',
    'no, eso no', 'nein, das nicht', 'não, isso não', 'non, pas ça',
  ];
  for (const t of corrections) assert.ok(hit(DEFAULTS.correctionPhrases, t), t);
  const grants = ['yes', 'go ahead', 'да', 'давай', 'так', 'sí', 'ja', 'sim', 'oui'];
  for (const t of grants) assert.ok(hit(DEFAULTS.grantPhrases, t), t);
  assert.ok(!hit(DEFAULTS.correctionPhrases, 'now add the footer'));
});

test('mergeConfig(undefined) returns a copy of the defaults', () => {
  const cfg = mergeConfig();
  assert.deepEqual(cfg, DEFAULTS);
  cfg.enabledDetectors.push('x');
  cfg.thresholds.blockLoop = 99;
  assert.equal(DEFAULTS.enabledDetectors.includes('x'), false);
  assert.equal(DEFAULTS.thresholds.blockLoop, 3);
});

test('mergeConfig deep-merges objects and replaces arrays', () => {
  const cfg = mergeConfig({
    thresholds: { blockLoop: 5 },
    enabledDetectors: ['hook-error'],
    ignoreProjects: ['demo'],
    judge: { enabled: true },
  });
  assert.deepEqual(cfg.thresholds, { blockLoop: 5, toolErrorLoop: 3 });
  assert.deepEqual(cfg.enabledDetectors, ['hook-error']);
  assert.deepEqual(cfg.ignoreProjects, ['demo']);
  assert.deepEqual(cfg.judge, { enabled: true, model: 'haiku' });
});

test('user phrases are appended to the defaults', () => {
  const cfg = mergeConfig({ correctionPhrases: ['^custom bad'], grantPhrases: ['^custom ok'] });
  assert.equal(cfg.correctionPhrases.length, DEFAULTS.correctionPhrases.length + 1);
  assert.ok(cfg.correctionPhrases.includes('^custom bad'));
  assert.ok(cfg.correctionPhrases.includes(DEFAULTS.correctionPhrases[0]));
  assert.equal(cfg.grantPhrases.length, DEFAULTS.grantPhrases.length + 1);
});

test('replaceDefaultPhrases replaces the defaults', () => {
  const cfg = mergeConfig({
    replaceDefaultPhrases: true,
    correctionPhrases: ['^only'],
    grantPhrases: ['^yes please'],
  });
  assert.deepEqual(cfg.correctionPhrases, ['^only']);
  assert.deepEqual(cfg.grantPhrases, ['^yes please']);
});

test('keys starting with underscore are ignored', () => {
  const cfg = mergeConfig({ _comment: 'hi', _nested: { a: 1 }, retentionDays: 10 });
  assert.equal(cfg._comment, undefined);
  assert.equal(cfg._nested, undefined);
  assert.equal(cfg.retentionDays, 10);
});

test('mergeConfig ignores non-object input', () => {
  assert.deepEqual(mergeConfig(null), DEFAULTS);
  assert.deepEqual(mergeConfig([1, 2]), DEFAULTS);
  assert.deepEqual(mergeConfig('x'), DEFAULTS);
});

test('missing file gives defaults and no warnings', () => {
  const file = path.join(os.tmpdir(), 'hak-does-not-exist', 'config.json');
  const { config, warnings } = loadConfig(file);
  assert.deepEqual(config, DEFAULTS);
  assert.deepEqual(warnings, []);
});

test('invalid JSON gives defaults and a warning', () => {
  const { config, warnings } = loadConfig(tmpFile('{ not json'));
  assert.deepEqual(config, DEFAULTS);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /invalid JSON/i);
});

test('a JSON value that is not an object gives defaults and a warning', () => {
  const { config, warnings } = loadConfig(tmpFile('[1,2]'));
  assert.deepEqual(config, DEFAULTS);
  assert.equal(warnings.length, 1);
});

test('valid file is merged over defaults', () => {
  const { config, warnings } = loadConfig(tmpFile(JSON.stringify({ retentionDays: 7, correctionPhrases: ['^zzz'] })));
  assert.deepEqual(warnings, []);
  assert.equal(config.retentionDays, 7);
  assert.ok(config.correctionPhrases.includes('^zzz'));
});

test('an invalid regex in phrases is dropped with a warning', () => {
  const { config, warnings } = loadConfig(tmpFile(JSON.stringify({
    correctionPhrases: ['(unclosed', '^fine'],
    grantPhrases: ['[bad'],
    bypassPatterns: ['*oops', 'ok\\d'],
  })));
  assert.ok(config.correctionPhrases.includes('^fine'));
  assert.equal(config.correctionPhrases.includes('(unclosed'), false);
  assert.equal(config.grantPhrases.includes('[bad'), false);
  assert.deepEqual(config.bypassPatterns, ['ok\\d']);
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some((w) => w.includes('(unclosed')));
});

test('forbidden entries are validated and defaulted', () => {
  const good = { id: 'a', tool: '^Bash$', pattern: 'rm\\s', message: 'no' };
  const { config, warnings } = loadConfig(tmpFile(JSON.stringify({
    forbidden: [
      good,
      { id: 'b', tool: '^Edit$', pattern: 'x', field: 'file_path' },
      { tool: '^Bash$', pattern: 'x' },
      { id: 'c', pattern: 'x', tool: '^Bash$', field: 'bogus' },
      { id: 'd', tool: '(', pattern: 'x' },
      { id: 'e', tool: '^Bash$', pattern: '(' },
      { id: 'f', tool: '^Bash$' },
      'junk',
    ],
  })));
  assert.deepEqual(config.forbidden.map((f) => f.id), ['a', 'b']);
  assert.equal(config.forbidden[0].field, 'any');
  assert.equal(config.forbidden[1].field, 'file_path');
  assert.equal(warnings.length, 6);
});

test('loadConfig never throws on a directory path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hak-'));
  const { config, warnings } = loadConfig(dir);
  assert.deepEqual(config, DEFAULTS);
  assert.equal(warnings.length, 1);
});

test('loadConfig default file honours HARNESS_AUDIT_KIT_HOME', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hak-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ retentionDays: 3 }));
  const prev = process.env.HARNESS_AUDIT_KIT_HOME;
  process.env.HARNESS_AUDIT_KIT_HOME = dir;
  try {
    assert.equal(loadConfig().config.retentionDays, 3);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_AUDIT_KIT_HOME;
    else process.env.HARNESS_AUDIT_KIT_HOME = prev;
  }
});

test('config.example.json parses, shows every key and all regexes compile', () => {
  const file = path.join(__dirname, '..', 'config.example.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(typeof raw._comment, 'string');
  for (const key of Object.keys(DEFAULTS)) assert.ok(key in raw, `missing ${key}`);
  assert.ok('replaceDefaultPhrases' in raw);
  assert.equal(raw.forbidden.length, 1);
  const { config, warnings } = loadConfig(file);
  assert.deepEqual(warnings, []);
  assert.equal(config.forbidden[0].id, 'no-npm');
  const f = config.forbidden[0];
  assert.ok(new RegExp(f.pattern).test('npm install left-pad'));
  assert.ok(!new RegExp(f.pattern).test('pnpm install'));
});
