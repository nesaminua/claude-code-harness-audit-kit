'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const correction = require('../../scripts/lib/detectors/user-correction');
const interrupt = require('../../scripts/lib/detectors/user-interrupt');

const deps = { redact: (s) => s, truncate: (s, n) => s.slice(0, n) };
const S = 'alice-session-0001';

let seq = 0;
const user = (text, session = S) => {
  seq += 1;
  return { kind: 'user_text', session, line: seq, ts: '2026-01-01T00:00:00Z', text };
};
const asst = (text, session = S) => ({ kind: 'assistant_text', session, text });

function run(mod, config, events) {
  const d = mod.create(config, deps);
  for (const ev of events) d.onEvent(ev);
  return d.finish();
}
const flat = { correctionPhrases: ['^no[,.!\\s]', 'я же (сказал|просил)'] };

test('English correction fires with key group any', () => {
  const r = run(correction, flat, [user('no, I said use pnpm')]);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, 'user-correction');
  assert.equal(r.findings[0].severity, 'low');
  assert.equal(r.findings[0].key, 'user-correction:any');
  assert.equal(r.findings[0].summary, 'no, I said use pnpm');
});

test('Russian correction fires', () => {
  assert.equal(run(correction, flat, [user('я же просил не трогать тесты')]).findings.length, 1);
});

test('object config uses the language key as group', () => {
  const cfg = { correctionPhrases: { en: ['^no[,.!\\s]'], ru: ['я же (сказал|просил)'] } };
  const r = run(correction, cfg, [user('no, stop'), user('я же сказал')]);
  assert.deepEqual(r.findings.map((f) => f.key), ['user-correction:en', 'user-correction:ru']);
});

test('skipped prefixes produce nothing and no exposure', () => {
  const texts = ['/commit', '!no, x', '<command-name>no, x', '<task-notification>no, x', '<local-command-stdout>no, x', '[Request interrupted by user] no, x', 'Caveat: no, x'];
  const r = run(correction, flat, texts.map((t) => user(t)));
  assert.equal(r.findings.length, 0);
  assert.equal(r.exposedSessions.size, 0);
});

test('text over 400 characters is skipped', () => {
  const r = run(correction, flat, [user(`no, ${'x'.repeat(500)}`)]);
  assert.equal(r.findings.length, 0);
});

test('bare answer after a question is skipped', () => {
  const cfg = { correctionPhrases: ['^no[,.!\\s]', '^no$'] };
  assert.equal(run(correction, cfg, [asst('Proceed? (yes/no)'), user('no')]).findings.length, 0);
  assert.equal(run(correction, cfg, [asst('Pick one:\n1. alpha\n2. beta'), user('no')]).findings.length, 0);
  assert.equal(run(correction, cfg, [asst('Done.'), user('no')]).findings.length, 1);
});

test('invalid regex is skipped, valid ones still work', () => {
  const r = run(correction, { correctionPhrases: ['(', '^no[,.!\\s]'] }, [user('no, wrong')]);
  assert.equal(r.findings.length, 1);
  assert.equal(r.warnings.length, 1);
});

test('exposure holds sessions with a non-skipped user_text for each fired key', () => {
  const r = run(correction, flat, [user('no, stop'), user('fine', 'bob-session-0002'), user('/x', 'carol-session-3')]);
  assert.deepEqual([...r.exposureByKey.get('user-correction:any')].sort(), [S, 'bob-session-0002']);
  assert.deepEqual([...r.exposedSessions].sort(), [S, 'bob-session-0002']);
});

test('interrupt carries the preceding assistant text', () => {
  const r = run(interrupt, {}, [asst('Running the migration now'), user('[Request interrupted by user]')]);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].key, 'user-interrupt:esc');
  assert.equal(r.findings[0].severity, 'low');
  assert.equal(r.findings[0].summary, 'interrupted after: Running the migration now');
});

test('interrupt summary cuts the assistant text at 160 characters', () => {
  const r = run(interrupt, {}, [asst('a'.repeat(300)), user('[Request interrupted by user for tool use]')]);
  assert.equal(r.findings[0].summary, `interrupted after: ${'a'.repeat(160)}`);
});

test('CR-4: subagent and meta user_text give no findings and no exposure', () => {
  const sub = { ...user('no, I said use pnpm'), agent: 'subagent' };
  const meta = { ...user('no, I said use pnpm'), meta: true };
  const r = run(correction, flat, [sub, meta]);
  assert.equal(r.findings.length, 0);
  assert.equal(r.exposedSessions.size, 0);
  const i = run(interrupt, {}, [{ ...user('[Request interrupted by user]'), agent: 'subagent' }, { ...user('[Request interrupted by user]'), meta: true }]);
  assert.equal(i.findings.length, 0);
  assert.equal(i.exposedSessions.size, 0);
});

test('CR-4: teammate, agent and cross-session messages are skipped', () => {
  const texts = ['<teammate-message id="x">no, redo it', '<agent-message>no, redo it', '<cross-session-message from="x">no, redo it'];
  assert.equal(run(correction, flat, texts.map((t) => user(t))).findings.length, 0);
});

test('interrupt exposure is every session with a user_text', () => {
  const r = run(interrupt, {}, [user('hello'), user('hi', 'bob-session-0002')]);
  assert.equal(r.findings.length, 0);
  assert.deepEqual([...r.exposedSessions].sort(), [S, 'bob-session-0002']);
  assert.deepEqual([...r.exposureByKey.get('user-interrupt:esc')].sort(), [S, 'bob-session-0002']);
});

const FAKE = `sk-${'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3Ab4Cd5Ef6Gh7Ij8'}`;
const leaksFake = (obj) => {
  const text = JSON.stringify(obj);
  for (let i = 0; i + 12 <= FAKE.length; i += 1) if (text.includes(FAKE.slice(i, i + 12))) return true;
  return false;
};

test('F3: a token straddling the old cut never leaks from user-correction or user-interrupt', () => {
  const c = correction.create(flat);
  c.onEvent(user(`no, ${'x'.repeat(170)} ${FAKE}`));
  const cf = c.finish().findings;
  assert.equal(cf.length, 1);
  assert.equal(leaksFake(cf), false);
  const i = interrupt.create({});
  i.onEvent(asst(`${'y'.repeat(130)} ${FAKE}`));
  i.onEvent(user('[Request interrupted by user]'));
  const inf = i.finish().findings;
  assert.equal(inf.length, 1);
  assert.equal(leaksFake(inf), false);
});
