'use strict';

// Name-based masking, by rule: any assignment whose NAME carries a credential word as a delimited segment.
const SENSITIVE_SEGMENTS = new Set([
  'key', 'secret', 'secrets', 'token', 'pass', 'pwd', 'passwd', 'password', 'passphrase', 'auth', 'sig', 'signature',
  'cred', 'creds', 'credential', 'credentials', 'cookie', 'cookies', 'private', 'bearer', 'requirepass',
  'mnemonic', 'seed',
]);
// Concatenated names (PGPASSWORD, csrftoken, awssecretkey): these may end a single segment. `pass`/`auth`/`key` may not (compass, bypass).
const SENSITIVE_SUFFIXES = ['password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'accesskey', 'secretkey', 'privatekey', 'accountkey', 'credential', 'credentials', 'mnemonic'];
// A segment that says the value describes the secret instead of being one (token_count, secret_name, signature_algorithm).
const DESCRIBING_SEGMENTS = new Set([
  'count', 'counts', 'num', 'number', 'size', 'length', 'len', 'algorithm', 'alg', 'column', 'columns', 'type',
  'name', 'ttl', 'expires', 'expiry', 'policy', 'enabled', 'file', 'path', 'dir',
]);
const NAME_SPLIT = /[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

// A value that mixes letters and digits over 12+ characters is a secret even when the name only describes one (PASSWORD_TYPE_HINT=...).
const RANDOM_MIXED = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9+=_-]{12,}$/;

function isSensitiveName(name, value = '') {
  const segments = name.split(NAME_SPLIT).filter(Boolean).map((s) => s.toLowerCase());
  if (segments.some((s) => DESCRIBING_SEGMENTS.has(s))) return RANDOM_MIXED.test(value.trim()) && segments.some((s) => SENSITIVE_SEGMENTS.has(s) || SENSITIVE_SUFFIXES.some((x) => s.endsWith(x)));
  if (segments.length === 1 && (segments[0] === 'session' || segments[0] === 'sessionid')) return true;
  return segments.some((s) => SENSITIVE_SEGMENTS.has(s) || SENSITIVE_SUFFIXES.some((x) => s.endsWith(x)));
}

// Values that are not secrets: references, placeholders, booleans, short numbers, and (unquoted) short lowercase words.
// A $VAR is a reference only outside single quotes, where the shell would not expand it.
function isBenignValue(value, quote) {
  const v = value.trim();
  if (!v || /^<redacted/.test(v) || /^<[^>\s]{1,40}>$/.test(v)) return true;
  if (quote !== "'" && /^\$[{(A-Za-z_]/.test(v)) return true;
  if (/^(?:true|false|null|none|nil|yes|no|on|off)$/i.test(v) || /^\d{1,5}(?:\.\d+)?$/.test(v)) return true;
  return !quote && /^[a-z][a-z0-9]{0,4}$/.test(v);
}

const SENSITIVE_MARK = '<redacted:secret>';
// name, then closing quotes/brackets (also the escaped \" of JSON inside a string), then one of the operators.
const HEAD_CLOSERS = '(?:\\\\?["\'`]|\\])';
const HEAD_OPERATORS = '(?:=>|:=|\\+=|->|=(?!=)|:(?!:)|\\uff1a)';
const ASSIGN_HEAD = new RegExp(
  `(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,80})(${HEAD_CLOSERS}{0,3}[ \\t\\u00a0]{0,5}${HEAD_OPERATORS}[ \\t\\u00a0]{0,5})`,
  'g',
);
// "api_key: str = 'v'" (Pydantic) and "apiKey: string = 'v'" (TypeScript): the value follows the second '='.
const ANNOTATION = /(?:str|string|String|int|float|bool|boolean|bytes|any|Any|SecretStr|SecretBytes|Optional\[\w+\]|str \| None|string \| undefined)[ \t]{0,3}=(?!=)[ \t]{0,3}/y;
const BARE_VALUE = /\S{1,512}/y;
const CLOSERS = { '(': ')', '[': ']', '{': '}' };
const QUOTES = new Set(['"', "'", '`']);

// End index (exclusive) of a quoted value that opens at text[open]; null when it never closes on this line.
function quotedEnd(text, open, quote, escaped) {
  const closer = escaped ? `\\${quote}` : quote;
  for (let j = open + (escaped ? 2 : 1); j < text.length && j - open <= 513; j += 1) {
    if (text[j] === '\n') return null;
    if (!escaped && text[j] === '\\') { j += 1; continue; }
    if (text.startsWith(closer, j)) return j + closer.length;
  }
  return null;
}

function readQuoted(text, at) {
  const escaped = text[at] === '\\' && QUOTES.has(text[at + 1]);
  const quote = escaped ? text[at + 1] : text[at];
  if (!QUOTES.has(quote)) return null;
  const end = quotedEnd(text, at, quote, escaped);
  if (!end) return null;
  const open = escaped ? `\\${quote}` : quote;
  return { length: end - at, plain: text.slice(at + open.length, end - open.length), quote, replacement: open + SENSITIVE_MARK + open };
}

function readBracketed(text, at) {
  const close = CLOSERS[text[at]];
  if (!close) return null;
  const nl = text.indexOf('\n', at);
  const end = text.indexOf(close, at + 1);
  if (end < 0 || end - at > 513 || (nl >= 0 && end > nl)) return null;
  return { length: end - at + 1, plain: text.slice(at + 1, end), quote: '', replacement: SENSITIVE_MARK };
}

function readBlock(text, at) {
  const c = text[at];
  if ((c !== '|' && c !== '>') || !/^[-+]?[ \t]*(?:\r?\n|$)/.test(text.slice(at + 1, at + 8))) return null;
  const block = /^[^\n]*\n(?:[ \t]+[^\n]*(?:\n|$)){1,40}/.exec(text.slice(at + 1, at + 2049));
  return block ? { length: 1 + block[0].length, plain: 'block', quote: '"', replacement: `${c}\n  ${SENSITIVE_MARK}\n` } : null;
}

// YAML `password:\n  value`: the value sits on the next, indented line (not a nested `key: value` mapping).
function readNextLine(text, at) {
  const m = /^[ \t]*\r?\n([ \t]{1,40})(\S{1,512})/.exec(text.slice(at, at + 600));
  if (!m || /^[\w.-]+:$|:[ \t]/.test(m[2])) return null;
  return { length: m[0].length, plain: m[2], quote: '', replacement: `${m[0].slice(0, m[0].length - m[2].length)}${SENSITIVE_MARK}` };
}

// Tokenizes the right-hand side that starts at `at`: quoted string, bracketed literal, block scalar or bare word.
function readValue(text, at) {
  const found = readQuoted(text, at) || readBracketed(text, at) || readBlock(text, at) || readNextLine(text, at);
  if (found) return found;
  BARE_VALUE.lastIndex = at;
  const m = BARE_VALUE.exec(text);
  return m ? { length: m[0].length, plain: m[0], quote: '', replacement: SENSITIVE_MARK } : null;
}

function valueStart(text, at, head) {
  if (!/:[ \t ]*$/.test(head)) return at;
  ANNOTATION.lastIndex = at;
  const m = ANNOTATION.exec(text);
  return m ? at + m[0].length : at;
}

function maskAssignments(text) {
  let out = '';
  let last = 0;
  ASSIGN_HEAD.lastIndex = 0;
  for (let m = ASSIGN_HEAD.exec(text); m; m = ASSIGN_HEAD.exec(text)) {
    const at = valueStart(text, m.index + m[0].length, m[2]);
    const value = readValue(text, at);
    if (!value || !isSensitiveName(m[1], value.plain) || isBenignValue(value.plain, value.quote)) continue;
    out += text.slice(last, at) + value.replacement;
    last = at + value.length;
    ASSIGN_HEAD.lastIndex = last;
  }
  return out + text.slice(last);
}

// .NET `<add key="ApiKey" value="v"/>` and `<password>v</password>`: the name and the value sit in different nodes.
const KEY_VALUE_ATTRS = /(\b(?:key|name)\s{0,3}=\s{0,3}["'])([^"'<>]{1,80})(["']\s{1,5}value\s{0,3}=\s{0,3}["'])([^"'<>]{1,512})(["'])/gi;
const XML_ELEMENT = /(<([A-Za-z][A-Za-z0-9_.:-]{0,60})(?:\s[^<>]{0,200})?>)([^<>]{1,512})(<\/\2>)/g;

const maskAttrs = (m, a, name, b, val, c) => (isSensitiveName(name, val) && !isBenignValue(val, '"') ? a + name + b + SENSITIVE_MARK + c : m);
const maskElement = (m, open, tag, inner, close) => (isSensitiveName(tag, inner) && !isBenignValue(inner, '') ? open + SENSITIVE_MARK + close : m);

const QUERY_PARAM = /(?<=[?&#;])([A-Za-z0-9_.%-]{1,80})=([^&#\s"'<>;]{1,2048})/g;
const AZURE_SAS = /(?<=[?&])sv=\d{4}-\d{2}-\d{2}(?:&[A-Za-z]{1,8}=[^&\s"'#]{0,512}){1,14}/g;
const SET_FORM = /(?<![A-Za-z0-9_-])(setx?\s{1,5})([A-Za-z0-9_.:/@-]{1,120})([ \t]{1,5})(?!<redacted)("[^"\n]{0,512}"|'[^'\n]{0,512}'|\S{1,512})/g;
const SECRETS_SET = /(?<![A-Za-z0-9_-])(secrets?\s{1,5}set\s)([^\n|;&]{1,512})/g;

const maskQuery = (m, name, val) => (isSensitiveName(name, val) && !isBenignValue(val, '') ? `${name}=${SENSITIVE_MARK}` : m);
const quoteOf = (val) => (val[0] === '"' || val[0] === "'" ? val[0] : '');
const maskSet = (m, set, name, sp, val) => (!val.startsWith('-') && isSensitiveName(name, val) && !isBenignValue(val.replace(/^["']|["']$/g, ''), quoteOf(val)) ? `${set}${name}${sp}${SENSITIVE_MARK}` : m);
const maskSecretsSet = (m, head, rest) => head + rest
  .replace(/(--body|--value|-b)(\s+|=)("[^"\n]{0,512}"|'[^'\n]{0,512}'|\S+)/g, `$1$2${SENSITIVE_MARK}`)
  .replace(/(\b[A-Za-z0-9_.-]{1,80}=)(?!<redacted)("[^"\n]{0,512}"|'[^'\n]{0,512}'|[^\s]+)/g, `$1${SENSITIVE_MARK}`);

function maskByName(text) {
  const marked = text.replace(KEY_VALUE_ATTRS, maskAttrs).replace(XML_ELEMENT, maskElement);
  const queried = marked.replace(AZURE_SAS, '<redacted:sas>').replace(QUERY_PARAM, maskQuery);
  const settled = queried.replace(SECRETS_SET, maskSecretsSet).replace(SET_FORM, maskSet);
  return maskAssignments(settled);
}

const NAME_PATTERNS = [
  ['assign-head', ASSIGN_HEAD],
  ['key-value-attrs', KEY_VALUE_ATTRS],
  ['xml-element', XML_ELEMENT],
  ['query-param', QUERY_PARAM],
  ['azure-sas', AZURE_SAS],
  ['set-form', SET_FORM],
  ['secrets-set', SECRETS_SET],
];

module.exports = { maskByName, isSensitiveName, isBenignValue, NAME_PATTERNS };
