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
  const { config, warnings } = loadConfig(tmpFile(JSON.stringify({ retentionDays: 20, correctionPhrases: ['^zzz'] })));
  assert.deepEqual(warnings, []);
  assert.equal(config.retentionDays, 20);
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
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ retentionDays: 30 }));
  const prev = process.env.HARNESS_AUDIT_KIT_HOME;
  process.env.HARNESS_AUDIT_KIT_HOME = dir;
  try {
    assert.equal(loadConfig().config.retentionDays, 30);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_AUDIT_KIT_HOME;
    else process.env.HARNESS_AUDIT_KIT_HOME = prev;
  }
});

const matches = (list, text) => list.some((s) => new RegExp(s, 'iu').test(text));

const BENIGN_CORRECTION = {
  en: ['No worries', 'No rush', 'No problem, thanks', 'Nothing failed here', 'I told your team about it', 'Why did youtube change'],
  ru: ['не такой уж', 'не так уж плохо', 'не такая большая', 'нетерпение', 'зачем тыква нужна', 'неправильное название'],
  uk: ['також треба', 'такий день', 'ніхто не прийшов', 'навіщо тут', 'це неправильне', 'не такий вже'],
  es: ['ya te dijeron la hora', 'está malísimo', 'la sala está malva', 'no es esotérico', 'no hagas esto'],
  de: ['Neinsager gesucht', 'das ist falscher Alarm', 'mach das nichtig', 'warum hast duschen', 'ich habe gesagtes'],
  pt: ['isso está erradicado', 'não faço isso', 'por que você fezes', 'eu já disseram', 'nãozinho'],
  fr: ['nonchalant', "c'est fauxbourdon", 'pourquoi as-tunisien', 'ne fais pas çaque', 'ça va, ouistiti'],
};

const BENIGN_GRANT = {
  en: ['okay so the build', 'yesterday I ran it', 'okapi', 'doing it later', 'approval needed'],
  ru: ['давно хотел', 'окно закрыто', 'делать нечего', 'давайте', 'такси приехало'],
  uk: ['також треба', 'такий день', 'добреньке', 'таксист'],
  es: ['valentina llegó', 'sígueme', 'valer la pena'],
  de: ['jahrelang', 'machen wir', 'jawohl'],
  pt: ['simples assim', 'podemos começar', 'simulação'],
  fr: ['ouistiti', 'vasistas', 'ouin'],
};

const REAL_CORRECTION = [
  'No, that is not it', 'No.', 'no', 'I already told you', "that's wrong", 'why did you do that', "don't do that",
  'Нет, не так', 'Это не так!', 'не так как я просил', 'я же сказал', 'зачем ты это сделал',
  'ні, не так', 'я ж казав', 'навіщо ти це зробив', 'це неправильно', 'не роби так',
  'ya te dije', 'por qué hiciste eso', 'no hagas eso', 'está mal',
  'nein, das nicht', 'ich habe doch gesagt', 'warum hast du das gemacht', 'mach das nicht',
  'não, isso não', 'eu já disse', 'isso está errado', 'não faça isso',
  'non, pas ça', "je t'ai dit", "c'est faux", 'pourquoi as-tu fait ça', 'ne fais pas ça',
];

const REAL_GRANT = [
  'yes', 'ok', 'go ahead', 'do it', 'approved', 'да', 'ок', 'давай', 'делай', 'так', 'добре', 'так, давай',
  'sí', 'vale', 'ja', 'mach', 'sim', 'pode', 'oui', 'vas-y',
];

test('benign sentences do not match the default correction phrases', () => {
  for (const [lang, list] of Object.entries(BENIGN_CORRECTION)) {
    assert.ok(list.length >= 5, lang);
    for (const t of list) assert.equal(matches(DEFAULTS.correctionPhrases, t), false, `${lang}: ${t}`);
  }
});

test('benign sentences do not match the default grant phrases', () => {
  for (const [lang, list] of Object.entries(BENIGN_GRANT)) {
    assert.ok(list.length >= 3, lang);
    for (const t of list) assert.equal(matches(DEFAULTS.grantPhrases, t), false, `${lang}: ${t}`);
  }
});

test('real corrections still match the default correction phrases', () => {
  for (const t of REAL_CORRECTION) assert.ok(matches(DEFAULTS.correctionPhrases, t), t);
});

test('real approvals still match the default grant phrases', () => {
  for (const t of REAL_GRANT) assert.ok(matches(DEFAULTS.grantPhrases, t), t);
});

const CONTINUING_STATEMENT = {
  en: [
    "that's wrong version of node in the lockfile", "that's wrong path in the docs table", "that's wrong side of the diff",
    "that's wrong column order in the CSV export", "that's wrong tab, the other file has it",
  ],
  ru: [
    'это неправильно настроенный конфиг', 'это неправильно указанный путь в файле', 'не так давно мы обновили схему',
    'не так быстро как хотелось бы', 'это неправильно названная колонка',
  ],
  uk: [
    'це неправильно вказаний шлях', 'це неправильно названа колонка', 'не так давно ми оновили схему',
    'не так швидко як хотілося', 'це неправильно налаштований конфіг',
  ],
  es: [
    'Está mal formateado el JSON?', 'está mal configurada la variable', 'está mal escrito el nombre del archivo',
    'no es eso lo que dice el log', 'eso no es correcto según el log', 'está mal el orden de las columnas',
  ],
  de: [
    'das ist falsch konfiguriert in der CI', 'das ist falsch herum eingebaut', 'das ist falsch geschrieben im Log',
    'das ist falsch benannt', 'das ist falsch gesetzt in der env', 'das ist nicht das Problem im Log',
  ],
  pt: [
    'isso está errado no relatório de ontem', 'isso está errado na tabela de preços', 'não é isso que o log mostra',
    'isso está errado por causa do fuso', 'isso esta errado no schema',
  ],
  fr: [
    'c\'est faux positif dans le rapport', 'c\'est faux depuis la v2', "c'est pas ça le problème du log",
    "c'est faux dans la doc aussi", "c'est faux selon le schéma",
  ],
};

const FINAL_CORRECTIONS = [
  "that's wrong.", "that's wrong again", "that's wrong!", 'не так.', 'Это не так, ещё раз', 'это неправильно!',
  'це неправильно знову', 'це неправильно.', 'Está mal.', 'está mal otra vez', 'Está mal, otra vez', 'no es eso.',
  'eso no es correcto.', 'das ist falsch.', 'das ist falsch schon wieder', 'isso está errado de novo',
  'não é isso!', 'isso está errado.', "c'est faux.", "c'est faux encore", "c'est pas ça !", 'está mal',
];

test('a phrase that continues into a statement is not a correction (every language)', () => {
  for (const [lang, list] of Object.entries(CONTINUING_STATEMENT)) {
    assert.ok(list.length >= 5, lang);
    for (const t of list) assert.equal(matches(DEFAULTS.correctionPhrases, t), false, `${lang}: ${t}`);
  }
});

test('the same phrases still match when they end the sentence', () => {
  for (const t of FINAL_CORRECTIONS) assert.ok(matches(DEFAULTS.correctionPhrases, t), t);
});

function loaded(obj) {
  return loadConfig(tmpFile(JSON.stringify(obj)));
}

const INVALID_FIELDS = [
  ['queue: null', { queue: null }, (c) => c.queue, DEFAULTS.queue],
  ['queue.expireDays: 0', { queue: { expireDays: 0 } }, (c) => c.queue, DEFAULTS.queue],
  ['queue.expireDays: 1.5', { queue: { expireDays: 1.5 } }, (c) => c.queue.expireDays, 14],
  ['retentionDays: 0', { retentionDays: 0 }, (c) => c.retentionDays, 60],
  ['retentionDays: 14', { retentionDays: 14 }, (c) => c.retentionDays, 60],
  ['retentionDays: string', { retentionDays: '30' }, (c) => c.retentionDays, 60],
  ['thresholds.blockLoop: x', { thresholds: { blockLoop: 'x' } }, (c) => c.thresholds, DEFAULTS.thresholds],
  ['thresholds.toolErrorLoop: 1', { thresholds: { toolErrorLoop: 1 } }, (c) => c.thresholds.toolErrorLoop, 3],
  ['thresholds: array', { thresholds: [] }, (c) => c.thresholds, DEFAULTS.thresholds],
  ['inject.maxItems: 21', { inject: { maxItems: 21 } }, (c) => c.inject.maxItems, 5],
  ['inject.maxItems: 0', { inject: { maxItems: 0 } }, (c) => c.inject.maxItems, 5],
  ['inject.maxChars: 100', { inject: { maxChars: 100 } }, (c) => c.inject.maxChars, 4000],
  ['inject.maxChars: 9001', { inject: { maxChars: 9001 } }, (c) => c.inject.maxChars, 4000],
  ['enabledDetectors: string', { enabledDetectors: 'hook-error' }, (c) => c.enabledDetectors, DEFAULTS.enabledDetectors],
  ['judge: string', { judge: 'yes' }, (c) => c.judge, DEFAULTS.judge],
  ['judge: null', { judge: null }, (c) => c.judge, DEFAULTS.judge],
  ['projectsDir: 5', { projectsDir: 5 }, (c) => c.projectsDir, null],
  ['ignoreProjects: string', { ignoreProjects: 'demo' }, (c) => c.ignoreProjects, []],
  ['ignoreProjects: [1]', { ignoreProjects: ['ok', 1] }, (c) => c.ignoreProjects, []],
];

for (const [name, input, pick, expected] of INVALID_FIELDS) {
  test(`invalid ${name} falls back to the default with a warning`, () => {
    const { config, warnings } = loaded(input);
    assert.deepEqual(pick(config), expected);
    assert.equal(warnings.length, 1, warnings.join('|'));
  });
}

test('unknown detector ids are dropped with a warning, known ones kept', () => {
  const { config, warnings } = loaded({ enabledDetectors: ['hook-error', 'made-up', 'block-loop'] });
  assert.deepEqual(config.enabledDetectors, ['hook-error', 'block-loop']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /made-up/);
});

test('all-unknown detector list falls back to the default', () => {
  const { config } = loaded({ enabledDetectors: ['nope'] });
  assert.deepEqual(config.enabledDetectors, DEFAULTS.enabledDetectors);
});

test('valid boundary values pass without warnings', () => {
  const ok = {
    queue: { expireDays: 1 }, retentionDays: 15, thresholds: { blockLoop: 2, toolErrorLoop: 2 },
    inject: { maxItems: 20, maxChars: 200 }, judge: { enabled: true }, projectsDir: '/tmp/x',
    ignoreProjects: ['a'], enabledDetectors: [],
  };
  const { config, warnings } = loaded(ok);
  assert.deepEqual(warnings, []);
  assert.equal(config.retentionDays, 15);
  assert.equal(config.inject.maxChars, 200);
  assert.deepEqual(config.enabledDetectors, []);
  assert.equal(config.projectsDir, '/tmp/x');
});

test('an invalid mix reports one warning per bad field and keeps the good ones', () => {
  const { config, warnings } = loaded({ queue: null, retentionDays: 0, thresholds: { blockLoop: 5 } });
  assert.equal(warnings.length, 2);
  assert.equal(config.thresholds.blockLoop, 5);
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
