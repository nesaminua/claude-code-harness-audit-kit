'use strict';

const fs = require('fs');
const paths = require('./paths');

const END = '(?![\\p{L}\\p{N}])';

const DEFAULTS = {
  enabledDetectors: [
    'block-loop', 'block-bypassed', 'retry-verbatim', 'tool-error-loop',
    'user-correction', 'user-interrupt', 'hook-error', 'forbidden-pattern',
  ],
  thresholds: { blockLoop: 3, toolErrorLoop: 3 },
  correctionPhrases: [
    // EN
    '^no[,.!\\s]', '\\bI (already )?(said|told you)\\b', "\\bthat'?s (wrong|not what I)\\b",
    '\\bwhy did you\\b', "\\bdon'?t do that\\b", '\\bnot what I (asked|wanted)\\b',
    // RU
    '^нет[,.!\\s]', 'я же (сказал|просил|говорил)', 'не так', 'зачем ты', 'это неправильно',
    'не то что я', 'не делай так',
    // UK
    '^ні[,.!\\s]', 'я ж казав', 'навіщо ти', 'це неправильно', 'не так як я', 'не роби так',
    // ES
    'ya te (dije|pedí)', 'eso no es (lo que|correcto)', 'por qué hiciste', 'no hagas eso',
    'está mal', 'no es eso',
    // DE
    '^nein[,.!\\s]', 'ich habe (dir )?(doch )?gesagt', 'das ist (falsch|nicht (das|was))',
    'warum hast du', 'mach das nicht', 'nicht das was ich',
    // PT
    '^n[ãa]o[,.!\\s]', 'eu já (disse|falei|pedi)', 'isso (está|esta) errado', 'por que (você )?fez',
    'n[ãa]o fa[çc]a isso', 'não é isso',
    // FR
    '^non[,.!\\s]', "je t'ai (déjà )?(dit|demandé)", "c'est (faux|pas ça)", 'pourquoi as-tu',
    'ne fais pas ça', "ce n'est pas ce que",
  ],
  grantPhrases: [
    `^(yes|yep|ok|go ahead|approved?|do it)${END}`,
    '^(да|ок|давай|разрешаю|делай)',
    '^(так|добре)',
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
const APPENDED = ['correctionPhrases', 'grantPhrases'];

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

function validate(config, warnings) {
  const out = { ...config };
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
