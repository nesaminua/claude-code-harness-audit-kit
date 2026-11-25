'use strict';

// Backstop for secrets whose name and shape no rule knows: long random-looking tokens, and seed phrases.
const CANDIDATE = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{20,}/g;
const MIN_BITS = 4.0;
const MARK = '<redacted:entropy>';

function shannon(text) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) || 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
  return bits;
}

const classCount = (t) => [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(t)).length;

// An identifier, slug or id: every part is a word, a number or a hex id (camelCase, kebab-case, snake_case,
// `agent-<hex>`, test_case_1_2). Random base64url has parts that mix cases and digits, so it never passes.
function isWordLike(token) {
  const parts = token.split(/[-_]+|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).filter(Boolean);
  const isPart = (p) => /^[A-Za-z]{1,16}\d{0,4}$/.test(p) || /^\d{1,8}$/.test(p) || /^[0-9a-f]{6,40}$/.test(p);
  return parts.length > 1 && parts.every(isPart) && token.length / parts.length >= 2;
}

function decodesToText(token) {
  const bytes = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (bytes.length < 12) return false;
  const text = bytes.toString('latin1');
  if (/[:=]/.test(text)) return false;
  return /^[\x20-\x7e\n\r\t]+$/.test(text) && (text.match(/[A-Za-z ]/g) || []).length / text.length >= 0.7;
}

// base64 of user:password (an Authorization: Basic payload, a .git-credentials line) is a secret, not prose.
function isBase64Credential(token) {
  if (!/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(token)) return false;
  const text = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
  return /^[A-Za-z0-9._@+-]{1,64}:(?!\/\/)[\x21-\x7e]{4,}$/.test(text);
}

// A hex run of 32+ chars is a key unless the text around it says it is a hash: a git object id after a git word
// or in a git URL, or a digest after its algorithm name (sha256:<64 hex>, @sha256:<64 hex>, md5 <32 hex>).
const HEX_RUN = /^[0-9a-fA-F]{32,}$/;
const GIT_CONTEXT = /(?:\b(?:commit|commits|sha|sha1|HEAD|rev|tree|blob|parent|merge)\b[^A-Za-z0-9]{0,6}|@|\/(?:commits?|blob|tree|raw|compare|objects)\/)$/i;
const HASH_MARKER = /(?:sha(?:1|224|256|384|512)|md5|digest|checksum)[^A-Za-z0-9]{0,4}$/i;
const DIGEST_LENGTHS = new Set([32, 40, 56, 64, 96, 128]);

function isHexSecret(hex, before) {
  if (!HEX_RUN.test(hex) || new Set(hex.toLowerCase()).size < 6) return false;
  if (hex.length === 40 && GIT_CONTEXT.test(before)) return false;
  return !(DIGEST_LENGTHS.has(hex.length) && HASH_MARKER.test(before));
}

function isExempt(token) {
  return /^[0-9a-f]{7,31}$/.test(token)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)
    || /^sha(?:1|256|384|512)-/.test(token)
    || /^[a-z0-9-]*__[a-z0-9_-]+$/.test(token)
    || isWordLike(token)
    || decodesToText(token);
}

function looksRandom(token) {
  return token.length >= 20 && classCount(token) >= 2 && shannon(token) >= MIN_BITS && !isExempt(token);
}

// A path of ordinary segments (src/components/Header, .claude/worktrees/agent-<hex>) is not a secret;
// a base64 blob with '/' in it is: its pieces are neither words nor ids.
const isPlainSegment = (s) => s.split(/[-_.]+/).every((part) => /^(?:[A-Za-z]{1,20}\d{0,4}|\d{1,12})$/.test(part) || part === '');
const isNormalSegment = (s) => !s || isPlainSegment(s) || isExempt(s) || /^[-_.]*[0-9a-f]{6,31}$/.test(s);
const stripSeparators = (s) => s.replace(/^[-_.]+/, '');

function maskPath(token, before) {
  const segments = token.split('/');
  const context = (i) => (i === 0 ? before : `/${segments[i - 1]}/`);
  const hexSecret = (seg, i) => isHexSecret(stripSeparators(seg), context(i));
  if (segments.every((seg, i) => !hexSecret(seg, i) && (isNormalSegment(seg) || HEX_RUN.test(stripSeparators(seg))))) return token;
  if (looksRandom(token)) return MARK;
  return segments.map((seg, i) => (hexSecret(seg, i) || looksRandom(seg) ? MARK : seg)).join('/');
}

function maskToken(token, before) {
  if (HEX_RUN.test(token)) return isHexSecret(token, before) ? MARK : token;
  if (isBase64Credential(token)) return MARK;
  if (isExempt(token)) return token;
  if (!token.includes('/')) return looksRandom(token) ? MARK : token;
  return maskPath(token, before);
}

const maskHighEntropy = (text) => text.replace(CANDIDATE, (token, offset, whole) => maskToken(token, whole.slice(Math.max(0, offset - 24), offset)));

const MNEMONIC = /(?<=[=:]\s{0,3}["']?|["'])(?:[a-z]{3,8} ){11,23}[a-z]{3,8}(?![A-Za-z])/g;
const STOPWORDS = new Set(['the', 'and', 'for', 'that', 'with', 'this', 'you', 'are', 'was', 'not', 'but', 'have', 'from', 'will', 'can', 'your', 'has', 'then', 'when', 'what']);

// 12-24 lowercase words after `=`/`:` or in quotes; prose with common function words is left alone.
const maskMnemonics = (text) => text.replace(MNEMONIC, (m) => (m.split(' ').filter((w) => STOPWORDS.has(w)).length >= 4 ? m : '<redacted:mnemonic>'));

const ENTROPY_PATTERNS = [['entropy-candidate', CANDIDATE], ['mnemonic', MNEMONIC]];

module.exports = { maskHighEntropy, maskMnemonics, ENTROPY_PATTERNS, shannon };
