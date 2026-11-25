'use strict';
const os = require('node:os');
const crypto = require('node:crypto');

const MAX_INPUT = 64 * 1024;
const NB = '(?<![A-Za-z0-9])';
const tok = (pattern) => new RegExp(NB + pattern, 'g');

// Every quantifier that can meet attacker text is bounded, and every unbounded run is entered through
// a lookbehind that lets the match start only at the beginning of that run (no quadratic rescans).
const VALUE = `"[^"\\n]{0,512}"|'[^'\\n]{0,512}'|\\S{1,512}`;
const HEADER_NAME = 'Proxy-Authorization|Authorization|Set-Cookie|Cookie|Api-Key|X-[A-Za-z0-9-]{0,40}?(?:Token|Key|Secret|Auth|Password)';

const toolRule = (tools, flags, kind) => [
  kind,
  new RegExp(`(?<![A-Za-z0-9_-])((?:${tools})\\s(?:[^\\n|;&]{0,300}?\\s)?(?:${flags}))(?!<redacted)(${VALUE})`, 'g'),
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

// Name-based masking, by rule: any assignment whose NAME carries a credential word as a delimited segment.
const SENSITIVE_SEGMENTS = new Set([
  'key', 'secret', 'secrets', 'token', 'pass', 'pwd', 'passwd', 'password', 'passphrase', 'auth', 'sig', 'signature',
  'cred', 'creds', 'credential', 'credentials', 'cookie', 'cookies', 'private', 'bearer', 'requirepass',
]);
// Concatenated names (PGPASSWORD, csrftoken, awssecretkey): these may end a single segment. `pass`/`auth`/`key` may not (compass, bypass).
const SENSITIVE_SUFFIXES = ['password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'accesskey', 'secretkey', 'privatekey', 'accountkey', 'credential', 'credentials'];
// A segment that says the value describes the secret instead of being one (token_count, secret_name, signature_algorithm).
const DESCRIBING_SEGMENTS = new Set([
  'count', 'counts', 'num', 'number', 'size', 'length', 'len', 'algorithm', 'alg', 'column', 'columns', 'type',
  'name', 'ttl', 'expires', 'expiry', 'policy', 'enabled', 'file', 'path', 'dir',
]);
const NAME_SPLIT = /[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

function isSensitiveName(name) {
  const segments = name.split(NAME_SPLIT).filter(Boolean).map((s) => s.toLowerCase());
  if (segments.some((s) => DESCRIBING_SEGMENTS.has(s))) return false;
  if (segments.length === 1 && (segments[0] === 'session' || segments[0] === 'sessionid')) return true;
  return segments.some((s) => SENSITIVE_SEGMENTS.has(s) || SENSITIVE_SUFFIXES.some((x) => s.endsWith(x)));
}

// Values that are not secrets: references, placeholders, booleans, short numbers, and (unquoted) short lowercase words.
function isBenignValue(value, quoted) {
  const v = value.trim();
  if (!v || /^<redacted/.test(v) || /^\$[{(A-Za-z_]/.test(v) || /^<[^>\s]{1,40}>$/.test(v)) return true;
  if (/^(?:true|false|null|none|nil|yes|no|on|off)$/i.test(v) || /^\d{1,5}(?:\.\d+)?$/.test(v)) return true;
  return !quoted && /^[a-z][a-z0-9]{0,4}$/.test(v);
}

const SENSITIVE_MARK = '<redacted:secret>';
const ASSIGN_HEAD = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,80})(["'\]]{0,3}[ \t ]{0,5}(?:=|:|：)[ \t ]{0,5})/g;
const BARE_VALUE = /\S{1,512}/y;
const CLOSERS = { '(': ')', '[': ']', '{': '}' };

// Returns {length, replacement, plain} for the value that starts at `at`, or null.
function readValue(text, at) {
  const c = text[at];
  const lineEnd = (() => { const i = text.indexOf('\n', at); return i < 0 ? text.length : i; })();
  const close = c === '"' || c === "'" ? c : CLOSERS[c];
  if (close) {
    const end = text.indexOf(close, at + 1);
    if (end > 0 && end < lineEnd && end - at <= 513) {
      const quote = c === '"' || c === "'";
      return { length: end - at + 1, plain: text.slice(at + 1, end), quoted: quote, replacement: quote ? `${c}${SENSITIVE_MARK}${c}` : SENSITIVE_MARK };
    }
  }
  if ((c === '|' || c === '>') && /^[-+]?[ \t]*(?:\r?\n|$)/.test(text.slice(at + 1, at + 8))) {
    const block = /^[^\n]*\n(?:[ \t]+[^\n]*(?:\n|$)){1,40}/.exec(text.slice(at + 1, at + 2049));
    if (block) return { length: 1 + block[0].length, plain: 'block', quoted: true, replacement: `${c}\n  ${SENSITIVE_MARK}\n` };
  }
  BARE_VALUE.lastIndex = at;
  const m = BARE_VALUE.exec(text);
  return m ? { length: m[0].length, plain: m[0], quoted: false, replacement: SENSITIVE_MARK } : null;
}

function maskAssignments(text) {
  let out = '';
  let last = 0;
  ASSIGN_HEAD.lastIndex = 0;
  for (let m = ASSIGN_HEAD.exec(text); m; m = ASSIGN_HEAD.exec(text)) {
    const at = m.index + m[0].length;
    if (!isSensitiveName(m[1])) continue;
    const value = readValue(text, at);
    if (!value || isBenignValue(value.plain, value.quoted)) continue;
    out += text.slice(last, at) + value.replacement;
    last = at + value.length;
    ASSIGN_HEAD.lastIndex = last;
  }
  return out + text.slice(last);
}

const QUERY_PARAM = /(?<=[?&#;])([A-Za-z0-9_.%-]{1,80})=([^&#\s"'<>;]{1,2048})/g;
const AZURE_SAS = /(?<=[?&])sv=\d{4}-\d{2}-\d{2}(?:&[A-Za-z]{1,8}=[^&\s"'#]{0,512}){1,14}/g;
const SET_FORM = /(?<![A-Za-z0-9_-])(set\s{1,5})([A-Za-z0-9_.:/@-]{1,120})([ \t]{1,5})(?!<redacted)("[^"\n]{0,512}"|'[^'\n]{0,512}'|\S{1,512})/g;
const SECRETS_SET = /(?<![A-Za-z0-9_-])(secrets?\s{1,5}set\s)([^\n|;&]{1,512})/g;

const maskQuery = (m, name, val) => (isSensitiveName(name) && !isBenignValue(val, false) ? `${name}=${SENSITIVE_MARK}` : m);
const maskSet = (m, set, name, sp, val) => (!val.startsWith('-') && isSensitiveName(name) && !isBenignValue(val.replace(/^["']|["']$/g, ''), val[0] === '"' || val[0] === "'") ? `${set}${name}${sp}${SENSITIVE_MARK}` : m);
const maskSecretsSet = (m, head, rest) => head + rest
  .replace(/(--body|--value|-b)(\s+|=)("[^"\n]{0,512}"|'[^'\n]{0,512}'|\S+)/g, `$1$2${SENSITIVE_MARK}`)
  .replace(/(\b[A-Za-z0-9_.-]{1,80}=)(?!<redacted)("[^"\n]{0,512}"|'[^'\n]{0,512}'|[^\s]+)/g, `$1${SENSITIVE_MARK}`);

function maskByName(text) {
  const queried = text.replace(AZURE_SAS, '<redacted:sas>').replace(QUERY_PARAM, maskQuery);
  const settled = queried.replace(SECRETS_SET, maskSecretsSet).replace(SET_FORM, maskSet);
  return maskAssignments(settled);
}

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
  ['assign-head', ASSIGN_HEAD],
  ['query-param', QUERY_PARAM],
  ['azure-sas', AZURE_SAS],
  ['set-form', SET_FORM],
  ['secrets-set', SECRETS_SET],
  ['email', EMAIL],
  ['temp-root', TEMP_ROOT],
  ...HOME_GENERIC.map((re, i) => [`home-generic-${i}`, re]),
];

module.exports = { redact, truncate, projectLabel, PATTERNS, MAX_INPUT };
