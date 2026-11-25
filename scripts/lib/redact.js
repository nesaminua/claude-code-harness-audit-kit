'use strict';
const os = require('node:os');
const crypto = require('node:crypto');

const NB = '(?<![A-Za-z0-9])';
const tok = (pattern) => new RegExp(NB + pattern, 'g');

// Order matters: structural patterns first, so later token shapes never re-mask their output.
const MASKS = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['credentials', /([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, '$1<redacted:credentials>@'],
  ['bearer', /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1<redacted:bearer>'],
  [
    'secret',
    /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)(["']?\s*[=:]\s*)(?!<redacted)\S+/gi,
    '$1$2<redacted:secret>',
  ],
  ['anthropic-key', tok('sk-ant-[A-Za-z0-9_-]+')],
  ['api-key', tok('sk-[A-Za-z0-9_-]{20,}')],
  ['stripe-key', tok('(?:sk_live|sk_test|rk_live)_[A-Za-z0-9]{10,}')],
  ['github-token', tok('(?:(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})')],
  ['slack-token', tok('xox[abpr]-[A-Za-z0-9-]+')],
  ['aws-key', tok('AKIA[0-9A-Z]{16}')],
  ['jwt', /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g],
  ['supabase-token', tok('sbp_[A-Za-z0-9]{20,}')],
  ['supabase-secret', tok('sb_secret_[A-Za-z0-9_-]+')],
  ['google-key', tok('AIza[0-9A-Za-z_-]{35}')],
  ['npm-token', tok('npm_[A-Za-z0-9]{36}')],
  ['xai-key', tok('xai-[A-Za-z0-9]{20,}')],
  ['gitlab-token', tok('glpat-[A-Za-z0-9_-]{20,}')],
];
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function redactHome(str, homedir) {
  let out = str;
  const base = (homedir || '').replace(/[\\/]+$/, '');
  if (base.length > 1) {
    const sep = '[\\\\/]';
    const parts = base.split(/[\\/]/).filter(Boolean).map(esc);
    const lead = /^[A-Za-z]:/.test(base) ? '' : sep;
    out = out.replace(new RegExp(lead + parts.join(sep) + '(?![A-Za-z0-9_])', 'gi'), '~');
    const encoded = base.replace(/[\\/:.]/g, '-');
    out = out.replace(new RegExp(`${NB}${esc(encoded)}(?![A-Za-z0-9_])`, 'g'), '~');
  }
  return out
    .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/]Users[\\/][^\\/\s]+/g, '<home>')
    .replace(/\/(?:Users|home)\/[^\\/\s]+/g, '<home>');
}

function redact(str, { homedir = os.homedir() } = {}) {
  let out = String(str);
  for (const [kind, re, replacement] of MASKS) out = out.replace(re, replacement || `<redacted:${kind}>`);
  out = out.replace(EMAIL, '<email>');
  return redactHome(out, homedir);
}

function truncate(str, n) {
  return str.length <= n ? str : str.slice(0, n) + '…';
}

function projectLabel(projectDirName) {
  const hash = crypto.createHash('sha1').update(projectDirName).digest('hex').slice(0, 6);
  return `${hash}/${projectDirName.split('-').pop()}`;
}

module.exports = { redact, truncate, projectLabel };
