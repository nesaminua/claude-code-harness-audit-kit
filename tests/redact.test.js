'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { redact, truncate, projectLabel } = require('../scripts/lib/redact.js');

const A = 'A'.repeat(24);
const tokens = {
  'anthropic-key': 'sk-' + 'ant-api03-' + A + '_x-y',
  'api-key': 'sk-' + 'proj_' + A,
  'stripe-key': ['sk', 'live', 'abcdefghij12'].join('_'),
  'stripe-test': ['sk', 'test', 'abcdefghij12'].join('_'),
  'stripe-restricted': ['rk', 'live', 'abcdefghij12'].join('_'),
  'github-token-p': 'gh' + 'p_' + A,
  'github-token-o': 'gh' + 'o_' + A,
  'github-token-s': 'gh' + 's_' + A,
  'github-token-u': 'gh' + 'u_' + A,
  'github-pat': 'github' + '_pat_' + A + '_1',
  'slack-token': 'xo' + 'xb-123456789-abcdefABCDEF',
  'slack-token-p': 'xo' + 'xp-123456789-abcdefABCDEF',
  'aws-key': 'AK' + 'IA' + 'ABCDEFGH12345678',
  jwt: ['ey' + 'JhbGciOiJIUzI1NiJ9', 'ey' + 'JzdWIiOiJhbGljZSJ9', 'c2lnbmF0dXJl'].join('.'),
  'supabase-token': 'sb' + 'p_' + A,
  'supabase-secret': 'sb_' + 'secret_' + A,
  'google-key': 'AI' + 'za' + 'B'.repeat(35),
  'npm-token': 'npm' + '_' + 'a1B2'.repeat(9),
  'xai-key': 'xa' + 'i-' + A,
  'gitlab-token': 'gl' + 'pat-' + A,
};

for (const [name, tok] of Object.entries(tokens)) {
  test(`masks ${name}`, () => {
    const out = redact(`key is ${tok} here`);
    assert.ok(!out.includes(tok), out);
    assert.match(out, /^key is <redacted:[a-z-]+> here$/);
  });
}

test('private key block', () => {
  const dashes = '-'.repeat(5);
  const label = ['RSA', 'PRIVATE', 'KEY'].join(' ');
  const b = `${dashes}BEGIN ${label}${dashes}\nMIIabc\ndef==\n${dashes}END ${label}${dashes}`;
  assert.equal(redact(`x\n${b}\ny`), 'x\n<redacted:private-key>\ny');
});

test('bearer token', () => {
  assert.equal(redact('Authorization: Bearer abcDEF123456.xyz'), 'Authorization: Bearer <redacted:bearer>');
});

test('name=value keeps the name', () => {
  assert.equal(redact('password=hunter2'), 'password=<redacted:secret>');
  assert.equal(redact('API_KEY: abc123'), 'API_KEY: <redacted:secret>');
  assert.equal(redact('access-key = zzz'), 'access-key = <redacted:secret>');
  assert.equal(redact('max_tokens: 5'), 'max_tokens: 5');
});

test('url credentials', () => {
  const scheme = 'postg' + 'res://';
  assert.equal(
    redact(`${scheme}alice${':'}s3cret@db.example.com:5432/x`),
    `${scheme}<redacted${':'}credentials>@db.example.com:5432/x`
  );
});

test('emails', () => {
  assert.equal(redact('mail alice@acme.example now'), 'mail <email> now');
});

test('plain words with token-like prefixes are untouched', () => {
  assert.equal(redact('task-abcdefghijklmnopqrstuvwxyz'), 'task-abcdefghijklmnopqrstuvwxyz');
});

test('home dir posix', () => {
  const o = { homedir: '/Users/alice' };
  assert.equal(redact('/Users/alice/dev/acme/a.js', o), '~/dev/acme/a.js');
  assert.equal(redact('/Users/alice', o), '~');
  assert.equal(redact('/Users/alice2/x', o), '<home>/x');
});

test('encoded home form', () => {
  assert.equal(redact('-Users-alice-dev-acme/abc.jsonl', { homedir: '/Users/alice' }), '~-dev-acme/abc.jsonl');
  assert.equal(redact('C--Users-alice-dev-acme', { homedir: 'C:\\Users\\alice' }), '~-dev-acme');
});

test('home dir windows, both separators', () => {
  const o = { homedir: 'C:\\Users\\alice' };
  assert.equal(redact('C:\\Users\\alice\\dev\\acme', o), '~\\dev\\acme');
  assert.equal(redact('C:/Users/alice/dev', o), '~/dev');
});

test('other users become <home>', () => {
  const o = { homedir: '/Users/alice' };
  assert.equal(redact('/Users/bob/x', o), '<home>/x');
  assert.equal(redact('/home/carol/x', o), '<home>/x');
  assert.equal(redact('C:\\Users\\dave\\x', o), '<home>\\x');
});

test('homedir defaults to os.homedir()', () => {
  const h = require('node:os').homedir();
  assert.equal(redact(h + '/x'), '~/x');
});

test('truncate', () => {
  assert.equal(truncate('abcdef', 3), 'abc…');
  assert.equal(truncate('abc', 3), 'abc');
});

test('redact then truncate never leaks a token prefix', () => {
  const tok = tokens['anthropic-key'];
  for (let n = 1; n < 40; n++) {
    const out = truncate(redact(`${tok} tail`), n);
    assert.ok(!out.includes('sk-'), out);
    assert.ok(!out.includes('api03'), out);
  }
});

test('projectLabel', () => {
  const d = '-Users-alice-dev-acme';
  const h = crypto.createHash('sha1').update(d).digest('hex').slice(0, 6);
  assert.equal(projectLabel(d), `${h}/acme`);
});
