'use strict';

const fs = require('fs');
const paths = require('./paths');

const END = '(?![\\p{L}\\p{N}])';
const BEGIN = '(?<![\\p{L}\\p{N}])';

// Short evaluative phrases count only when they end the sentence, optionally followed by one closed-list word.
const final = (core, tail) => `${core}(?:\\s+(?:${tail}))?(?=\\s*[,.!?…]|\\s*$)`;

const DEFAULTS = {
  enabledDetectors: [
    'block-loop', 'block-bypassed', 'retry-verbatim', 'tool-error-loop',
    'user-correction', 'user-interrupt', 'hook-error', 'forbidden-pattern',
    'hook-slow', 'subagent-max-turns', 'agent-usage-limit',
  ],
  thresholds: { blockLoop: 3, toolErrorLoop: 3, hookSlowMs: 5000, hookSlowMaxMs: null, hookSlowMinRuns: 20 },
  outcome: { minSessions: 10, regressionPct: 30, minDays: 7 },
  correctionPhrases: [
    // EN
    '^no$', '^no[,.!](?!\\s*(worries|problem|rush|need))', `\\bI (?:already (?:said|told you)|told you)${END}`,
    final("\\bthat'?s wrong", 'again'), `\\bthat'?s not what I${END}`, `\\bwhy did you${END}`,
    `\\bdon'?t do that${END}`, `\\bnot what I (asked|wanted)${END}`,
    // RU
    '^нет([,.!]|$)', `я же (сказал|просил|говорил)${END}`, final('не так', 'ещё раз|еще раз|опять|снова'),
    `не так,? как я${END}`, `зачем ты${END}`, final('это неправильно', 'ещё раз|еще раз|опять|снова'),
    `не то что я${END}`, `не делай так${END}`,
    // UK
    '^ні([,.!]|$)', `я ж казав${END}`, `навіщо ти${END}`, final('це неправильно', 'знову|знов|ще раз'),
    `не так,? як я${END}`, `не роби так${END}`,
    // ES
    `ya te (dije|pedí)${END}`, `eso no es lo que${END}`, final('eso no es correcto', 'otra vez|de nuevo'),
    `por qué hiciste${END}`, `no hagas eso${END}`, final('está mal', 'otra vez|de nuevo'),
    final('no es eso', 'otra vez|de nuevo'),
    // DE
    '^nein([,.!]|$)', `ich habe (dir )?(doch )?gesagt${END}`, final('das ist falsch', 'schon wieder|wieder|nochmal'),
    `warum hast du${END}`, `mach das nicht${END}`, `nicht das,? was ich${END}`,
    // PT
    '^n[ãa]o([,.!]|$)', `eu já (disse|falei|pedi)${END}`,
    final('isso (está|esta) errado', 'de novo|outra vez|novamente'), `por que (você )?fez${END}`,
    `n[ãa]o fa[çc]a isso${END}`, final('não é isso', 'de novo|outra vez|novamente'),
    // FR
    '^non([,.!]|$)', `je t'ai (déjà )?(dit|demandé)${END}`,
    final("c'est (faux|pas ça)", 'encore une fois|encore|de nouveau'), `pourquoi as-tu${END}`,
    `ne fais pas ça${END}`, `ce n'est pas ce que${END}`,
  ],
  // Fire alone, even inside a question: an unmistakable pushback.
  correctionStrongPhrases: [
    // EN
    `^stop(?:[!.,:;—-]|\\s*$)`, `${BEGIN}I (?:already (?:said|told you|asked)|told you)${END}`, `${BEGIN}forget (?:it|that|about)${END}`,
    `${BEGIN}why (?:did|would|are) you${END}`,
    `${BEGIN}I (?:don'?t|do not) (?:understand|get it)${END}`, `${BEGIN}(?:wtf|what the (?:hell|fuck)|damn it)${END}`,
    // RU
    `^стоп${END}`, `${BEGIN}я же (?:сказал|сказала|просил|просила|говорил|говорила|ответил|ответила)${END}`,
    `${BEGIN}забудь${END}`, `${BEGIN}не (?:понял|поняла|понимаю)${END}`, `${BEGIN}не могу понять${END}`,
    `${BEGIN}(?:блин|блять|блядь)${END}`, `${BEGIN}(?:зачем|почему) ты${END}`,
    // UK
    `${BEGIN}я ж (?:казав|казала|просив|просила|відповів|відповіла)${END}`, `${BEGIN}не (?:зрозумів|зрозуміла|розумію)${END}`,
    `${BEGIN}не можу зрозуміти${END}`, `${BEGIN}(?:блін|бляха)${END}`, `${BEGIN}(?:навіщо|чому) ти${END}`,
    // ES, DE, PT, FR: exact pushback phrases only
    `${BEGIN}ya te (?:dije|pedí)${END}`, `${BEGIN}olvídalo${END}`,
    `^stopp(?:[!.,:;—-]|\\s*$)`, `${BEGIN}vergiss (?:es|das)${END}`, `${BEGIN}ich verstehe (?:das )?nicht${END}`,
    `${BEGIN}eu já (?:disse|falei|pedi)${END}`, `${BEGIN}esquece (?:isso|tudo)${END}`, `${BEGIN}não entendi${END}`,
    `^arrête(?:[!.,:;—-]|\\s*$)`, `${BEGIN}je t'ai (?:déjà )?(?:dit|demandé)${END}`, `${BEGIN}oublie (?:ça|tout)${END}`,
    `${BEGIN}je n'ai pas compris${END}`,
  ],
  // Count only with a second signal: emphasis (!! or ??), a prohibition, the text starting with the marker,
  // or a bare "why?" at the end. A plain question never counts.
  correctionWeakPhrases: [
    // EN
    `${BEGIN}(?:why|again|wrong|no)${END}`,
    // RU
    `${BEGIN}(?:зачем|почему|нет|опять|снова|неправильно|хватит)${END}`, `${BEGIN}(?:ещё|еще) раз${END}`, `${BEGIN}не (?:нужно|надо)${END}`,
    // UK
    `${BEGIN}(?:навіщо|чому|ні|знову|знов|неправильно|досить)${END}`, `${BEGIN}ще раз${END}`, `${BEGIN}не (?:треба|потрібно)${END}`,
    // ES, DE, PT, FR
    `${BEGIN}por qué${END}`, `${BEGIN}(?:otra vez|de nuevo)${END}`,
    `${BEGIN}(?:warum|nochmal)${END}`, `${BEGIN}schon wieder${END}`,
    `${BEGIN}por que${END}`, `${BEGIN}(?:de novo|outra vez)${END}`,
    `${BEGIN}pourquoi${END}`, `${BEGIN}encore une fois${END}`,
  ],
  grantPhrases: [
    `^(yes|yep|ok|go ahead|approved?|do it)${END}`,
    `^(да|ок|давай|разрешаю|делай)${END}`,
    `^(так|добре)${END}`,
    `^(sí|vale)${END}`,
    `^(ja|mach)${END}`,
    `^(sim|pode)${END}`,
    `^(oui|vas-y)${END}`,
  ],
  bypassPatterns: [],
  forbidden: [],
  ignoreProjects: [],
  inject: { maxItems: 5, maxChars: 4000 },
  queue: { expireDays: 14 },
  retentionDays: 60,
  judge: { enabled: false, model: 'haiku' },
  projectsDir: null,
};

const FIELDS = ['command', 'file_path', 'pattern', 'any'];
const APPENDED = ['correctionPhrases', 'correctionStrongPhrases', 'correctionWeakPhrases', 'grantPhrases'];

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
}

function deepMerge(base, over) {
  const out = clone(base);
  for (const [key, value] of Object.entries(over)) {
    if (key.startsWith('_')) continue;
    out[key] = isPlain(value) && isPlain(out[key]) ? deepMerge(out[key], value) : clone(value);
  }
  return out;
}

function mergeConfig(user) {
  if (!isPlain(user)) return clone(DEFAULTS);
  const merged = deepMerge(DEFAULTS, user);
  if (user.replaceDefaultPhrases !== true) {
    for (const key of APPENDED) {
      if (Array.isArray(user[key])) merged[key] = [...DEFAULTS[key], ...user[key]];
    }
  }
  return merged;
}

function regexError(source) {
  if (typeof source !== 'string') return 'not a string';
  try {
    new RegExp(source, 'iu');
    return null;
  } catch (err) {
    return err.message;
  }
}

function validRegexList(list, name, warnings) {
  return list.filter((src) => {
    const err = regexError(src);
    if (err) warnings.push(`${name}: dropped invalid regex ${JSON.stringify(src)} (${err})`);
    return !err;
  });
}

function validForbidden(list, warnings) {
  const out = [];
  list.forEach((entry, i) => {
    const label = `forbidden[${i}]`;
    if (!isPlain(entry)) return warnings.push(`${label}: dropped, not an object`);
    const missing = ['id', 'tool', 'pattern'].filter((k) => typeof entry[k] !== 'string' || !entry[k]);
    if (missing.length) return warnings.push(`${label}: dropped, missing ${missing.join(', ')}`);
    const field = entry.field === undefined ? 'any' : entry.field;
    if (!FIELDS.includes(field)) return warnings.push(`${label}: dropped, field must be one of ${FIELDS.join(', ')}`);
    for (const key of ['tool', 'pattern']) {
      const err = regexError(entry[key]);
      if (err) return warnings.push(`${label}: dropped, invalid ${key} regex (${err})`);
    }
    out.push({ ...entry, field });
  });
  return out;
}

const intIn = (min, max = Infinity) => (v) => Number.isInteger(v) && v >= min && v <= max;

const OBJECT_KEYS = ['queue', 'thresholds', 'inject', 'judge', 'outcome'];
const NUMBER_RULES = [
  ['queue', 'expireDays', intIn(1)],
  ['thresholds', 'blockLoop', intIn(2)],
  ['thresholds', 'toolErrorLoop', intIn(2)],
  ['thresholds', 'hookSlowMs', intIn(500, 120000)],
  ['thresholds', 'hookSlowMinRuns', intIn(5, 1000)],
  ['outcome', 'minSessions', intIn(3)],
  ['outcome', 'regressionPct', intIn(5, 500)],
  ['outcome', 'minDays', intIn(1, 7)],
  ['inject', 'maxItems', intIn(1, 20)],
  ['inject', 'maxChars', intIn(200, 9000)],
];

function validateShape(out, warnings) {
  const fallback = (name) => {
    warnings.push(`${name}: invalid value, using the default`);
    return clone(DEFAULTS[name]);
  };
  for (const key of OBJECT_KEYS) if (!isPlain(out[key])) out[key] = fallback(key);
  for (const [group, key, ok] of NUMBER_RULES) {
    if (ok(out[group][key])) continue;
    warnings.push(`${group}.${key}: invalid value, using the default`);
    out[group][key] = DEFAULTS[group][key];
  }
  const maxMs = out.thresholds.hookSlowMaxMs;
  if (maxMs !== null && !intIn(out.thresholds.hookSlowMs)(maxMs)) {
    warnings.push('thresholds.hookSlowMaxMs: invalid value (null or an integer not below hookSlowMs), using null');
    out.thresholds.hookSlowMaxMs = null;
  }
  if (!intIn(15)(out.retentionDays)) out.retentionDays = fallback('retentionDays');
  if (out.projectsDir !== null && typeof out.projectsDir !== 'string') out.projectsDir = fallback('projectsDir');
  const strings = Array.isArray(out.ignoreProjects) && out.ignoreProjects.every((s) => typeof s === 'string');
  if (!strings) out.ignoreProjects = fallback('ignoreProjects');
}

function validateDetectors(out, warnings) {
  const list = out.enabledDetectors;
  if (!Array.isArray(list)) {
    warnings.push('enabledDetectors: invalid value, using the default');
    out.enabledDetectors = clone(DEFAULTS.enabledDetectors);
    return;
  }
  const ids = require('./detectors').IDS;
  const known = list.filter((id) => ids.includes(id));
  const unknown = list.filter((id) => !known.includes(id));
  if (unknown.length) warnings.push(`enabledDetectors: dropped unknown ${JSON.stringify(unknown)}`);
  out.enabledDetectors = list.length && !known.length ? clone(DEFAULTS.enabledDetectors) : known;
}

function validate(config, warnings) {
  const out = clone(config);
  validateShape(out, warnings);
  validateDetectors(out, warnings);
  for (const key of [...APPENDED, 'bypassPatterns']) {
    out[key] = Array.isArray(out[key]) ? validRegexList(out[key], key, warnings) : [];
  }
  out.forbidden = Array.isArray(out.forbidden) ? validForbidden(out.forbidden, warnings) : [];
  return out;
}

function loadConfig(file = paths.configFile()) {
  const warnings = [];
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') warnings.push(`cannot read ${file}: ${err.message}`);
    return { config: clone(DEFAULTS), warnings };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warnings.push(`invalid JSON in ${file}: ${err.message}`);
    return { config: clone(DEFAULTS), warnings };
  }
  if (!isPlain(parsed)) {
    warnings.push(`${file}: top level must be a JSON object`);
    return { config: clone(DEFAULTS), warnings };
  }
  return { config: validate(mergeConfig(parsed), warnings), warnings };
}

module.exports = { DEFAULTS, mergeConfig, loadConfig };
