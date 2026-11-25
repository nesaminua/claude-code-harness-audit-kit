'use strict';
const os = require('node:os');
const crypto = require('node:crypto');
const { maskByName, NAME_PATTERNS } = require('./redact-names.js');
const { maskHighEntropy, maskMnemonics, ENTROPY_PATTERNS } = require('./redact-entropy.js');

const MAX_INPUT = 64 * 1024;
const NB = '(?<![A-Za-z0-9])';
const tok = (pattern) => new RegExp(NB + pattern, 'g');

// Every quantifier that can meet attacker text is bounded, and every unbounded run is entered through
// a lookbehind that lets the match start only at the beginning of that run (no quadratic rescans).
const VALUE = `"[^"\\n]{0,512}"|'[^'\\n]{0,512}'|\\S{1,512}`;
const HEADER_NAME = 'Proxy-Authorization|Authorization|Set-Cookie|Cookie|Api-Key|X-[A-Za-z0-9-]{0,40}?(?:Token|Key|Secret|Auth|Password)';

const toolRule = (tools, flags, kind) => [
  kind,
  new RegExp(`(?<![A-Za-z0-9_-])((?:${tools})\\s(?:[^\\n|;&]{0,300}?\\s)?(?:${flags}))(?!<redacted|-)(${VALUE})`, 'g'),
  maskValue(kind),
];

function maskValue(kind) {
  return (match, head, val) => {
    const q = val[0] === '"' || val[0] === "'" ? val[0] : '';
    const inner = q ? `${q}<redacted:${kind}>${q}` : `<redacted:${kind}>`;
    return head + inner;
  };
}

// Order matters: structural patterns first, so later token shapes never re-mask their output.
const MASKS = [
  ['private-key', /-----BEGIN [A-Z ]{0,30}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]{0,30}PRIVATE KEY(?: BLOCK)?-----|$)/g],
  ['private-key', /(?<![A-Za-z0-9])PuTTY-User-Key-File-\d{1,2}:[\s\S]*?(?:Private-MAC:[ \t]*[0-9a-f]{0,64}|$)/g],
  // user:pass@ or :pass@ (the password may hold '@'), and a bare long token as user (https://<token>@host).
  ['credentials', /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{0,19}:\/\/)[^\s:/@]{0,128}:[^\s/]{1,256}@/gi, '$1<redacted:credentials>@'],
  ['credentials', /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{0,19}:\/\/)[A-Za-z0-9._~%-]{20,200}@/gi, '$1<redacted:credentials>@'],
  ['bearer', /\b(Bearer\s{1,20})[A-Za-z0-9._~+/=-]{8,}/gi, '$1<redacted:bearer>'],
  ['basic-auth', /(Authorization\s{0,5}[:=]\s{0,5}["']?Basic\s{1,20})[A-Za-z0-9+/=]{4,}/gi, '$1<redacted:basic-auth>'],
  [
    'header',
    new RegExp(`((?<![A-Za-z0-9_-])(?:${HEADER_NAME})["']?[ \\t]{0,5}:[ \\t]{0,5}["']?)(?![ \\t"']*(?:Bearer|Basic)\\s+<redacted)([^\\r\\n"']{1,2048})`, 'gi'),
    maskValue('header'),
  ],
  [
    'secret',
    new RegExp(`((?<![A-Za-z0-9_-])--?(?:[a-z0-9]{1,24}-){0,3}(?:password|passwd|pwd|passphrase|pass|token|api-?key|secret|access-?key|bearer)(?:=|[ \\t]+(?!-)))(?!<redacted)(${VALUE})`, 'gi'),
    maskValue('secret'),
  ],
  [
    'password',
    /(?<![A-Za-z0-9_-])((?:mysql|mysqldump|mysqladmin|mariadb|psql|7z|7za|7zr|rar|unrar)\s(?:[^\n|;&]{0,200}?\s)?-p)(?=\S)\S{1,128}/g,
    '$1<redacted:password>',
  ],
  toolRule('curl|wget|http|https|xh', '(?:-u|-U|--user|--proxy-user|-b|--cookie|--oauth2-bearer)(?:\\s{1,3}|=)', 'credentials'),
  toolRule('sshpass', '-p[ \\t]{0,3}', 'password'),
  toolRule('zip|unzip|zipcloak', '-P[ \\t]{1,3}', 'password'),
  toolRule('redis-cli', '-a[ \\t]{1,3}', 'password'),
  toolRule('(?:docker|podman|nerdctl)\\s+login', '-p[ \\t]{1,3}', 'password'),
  toolRule('security', '-w[ \\t]{1,3}', 'password'),
  toolRule('mongosh|mongo', '-p[ \\t]{1,3}', 'password'),
  toolRule('ldap(?:search|modify|add|delete|passwd|compare)', '-w[ \\t]{1,3}', 'password'),
  toolRule('smbclient|rpcclient|smbmap', '-U[ \\t]{1,3}[^\\s%]{1,64}%', 'password'),
  toolRule('htpasswd', '-[A-Za-z]*b[A-Za-z]*[ \\t]{1,3}\\S{1,256}[ \\t]{1,3}\\S{1,128}[ \\t]{1,3}', 'password'),
  toolRule('openssl', '-k[ \\t]{1,3}', 'password'),
  ['webhook', /(hooks\.slack\.com\/services\/)[A-Za-z0-9/_-]{1,200}/g, '$1<redacted:webhook>'],
  ['webhook', /(discord(?:app)?\.com\/api\/webhooks\/)\d{1,25}\/[A-Za-z0-9_-]{16,}/g, '$1<redacted:webhook>'],
  ['telegram-token', /(api\.telegram\.org\/(?:file\/)?bot)\d{3,20}:[A-Za-z0-9_-]{20,}/g, '$1<redacted:telegram-token>'],
  ['telegram-token', tok('\\d{8,12}:AA[A-Za-z0-9_-]{30,}')],
  ['password', /(?<![A-Za-z0-9_-])(-pass(?:in|out)?(?:\s{1,3}|=)pass:)\S{1,256}/g, '$1<redacted:password>'],
  [
    'password',
    /(?<![A-Za-z0-9._*:-])((?=[A-Za-z0-9._*-]{1,253}:)(?=[^:A-Za-z*]{0,253}[A-Za-z*])[A-Za-z0-9._*-]{1,253}:(?:\d{1,5}|\*):[A-Za-z0-9._*-]{1,63}:[A-Za-z0-9._*@-]{1,63}:)\S{1,256}/g,
    '$1<redacted:password>',
  ],
  [
    'password',
    /(?<![A-Za-z0-9_-])((?:machine\s{1,10}\S{1,253}|default)(?:\s{1,10}login\s{1,10}\S{1,128})?\s{1,10}password\s{1,10})\S{1,256}/g,
    '$1<redacted:password>',
  ],
  ['anthropic-key', tok('sk-ant-[A-Za-z0-9_-]+')],
  ['api-key', tok('sk-[A-Za-z0-9_-]{20,}')],
  ['stripe-key', tok('(?:sk_live|sk_test|rk_live|rk_test|pk_live|pk_test)_[A-Za-z0-9]{10,}')],
  ['stripe-webhook', tok('whsec_[A-Za-z0-9]{16,}')],
  ['github-token', tok('(?:(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})')],
  ['slack-token', tok('xox[abpr]-[A-Za-z0-9-]+')],
  ['aws-key', tok('AKIA[0-9A-Z]{16}')],
  ['jwt', /(?<![\w-])eyJ[\w-]+\.[\w-]+\.[\w-]+/g],
  ['supabase-token', tok('sbp_[A-Za-z0-9]{20,}')],
  ['supabase-secret', tok('sb_secret_[A-Za-z0-9_-]+')],
  ['google-key', tok('AIza[0-9A-Za-z_-]{35}')],
  ['npm-token', tok('npm_[A-Za-z0-9]{36}')],
  ['xai-key', tok('xai-[A-Za-z0-9]{20,}')],
  ['gitlab-token', tok('glpat-[A-Za-z0-9_-]{20,}')],
  ['huggingface-key', tok('hf_[A-Za-z0-9]{30,}')],
  ['sendgrid-key', tok('SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}')],
  ['replicate-key', tok('r8_[A-Za-z0-9]{20,}')],
  ['digitalocean-token', tok('dop_v1_[A-Za-z0-9]{32,}')],
  ['shopify-token', tok('(?:shpat|shpss|shpca|shppa)_[A-Za-z0-9]{20,}')],
  ['twilio-sid', tok('AC[0-9a-f]{32}')],
];
const EMAIL = /(?<![\w.+-])[\w.+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g;
const TEMP_ROOT = /(?:\/private)?\/var\/folders\/[A-Za-z0-9_]{2}\/[A-Za-z0-9_]{1,64}\//g;
const HOME_GENERIC = [
  /(?<![A-Za-z0-9])(?:[A-Za-z]-)?-(?:Users|home)-(?:[A-Za-z0-9._]+|$)/g,
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/]Users[\\/][^\\/\s]+/g,
  /\/(?:Users|home)\/[^\\/\s]+/g,
];

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
  // Callers may slice text mid-name before redacting, so any encoded home form is masked, truncated or not.
  return HOME_GENERIC.reduce((acc, re) => acc.replace(re, '<home>'), out);
}

function osUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || '';
  }
}

// Tools put the login name into temp dir names (e.g. .../T/<tool>-of-<name>/), which no home-path rule sees.
function redactUser(str, username) {
  if (!username || username.length < 3) return str;
  return str.replace(new RegExp(`(?<![A-Za-z0-9])${esc(username)}(?![A-Za-z0-9])`, 'gi'), '<user>');
}

// Cut back to the last whitespace so a token split by the cap never leaves a readable prefix.
function capInput(text) {
  if (text.length <= MAX_INPUT) return { text, capped: false };
  let end = MAX_INPUT;
  for (let i = MAX_INPUT - 1; i > MAX_INPUT - 256; i -= 1) {
    if (/\s/.test(text[i])) { end = i; break; }
  }
  return { text: text.slice(0, end), capped: true };
}

function redact(str, { homedir = os.homedir(), username = osUsername() } = {}) {
  const { text, capped } = capInput(String(str));
  let out = text;
  for (const [kind, re, replacement] of MASKS) out = out.replace(re, replacement || `<redacted:${kind}>`);
  out = maskByName(out);
  out = out.replace(EMAIL, '<email>').replace(TEMP_ROOT, '<tmp>/');
  out = redactUser(redactHome(out, homedir), username);
  out = maskHighEntropy(maskMnemonics(out));
  return capped ? `${out}…` : out;
}

function truncate(str, n) {
  return str.length <= n ? str : str.slice(0, n) + '…';
}

function projectLabel(projectDirName) {
  const hash = crypto.createHash('sha1').update(projectDirName).digest('hex').slice(0, 6);
  return `${hash}/${projectDirName.split('-').pop()}`;
}

const PATTERNS = [
  ...MASKS.map(([kind, re]) => [kind, re]),
  ...NAME_PATTERNS,
  ...ENTROPY_PATTERNS,
  ['email', EMAIL],
  ['temp-root', TEMP_ROOT],
  ...HOME_GENERIC.map((re, i) => [`home-generic-${i}`, re]),
];

module.exports = { redact, truncate, projectLabel, PATTERNS, MAX_INPUT };
