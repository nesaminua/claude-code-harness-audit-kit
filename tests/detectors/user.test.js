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

const { DEFAULTS } = require('../../scripts/lib/config');

function fires(text, previous = 'Done. I changed the config and ran the tests.') {
  const d = correction.create(DEFAULTS, deps);
  d.onEvent(asst(previous));
  d.onEvent(user(text));
  return d.finish().findings.length === 1;
}

const POSITIVE = {
  en: [
    'stop!', "Stop, that's not what I asked", 'I already told you to use pnpm', 'I already said no tests!!',
    'forget it, delete that file', 'forget about the migration', "I don't understand why you changed the config",
    'wtf is this', 'what the hell did you do', 'damn it, the same error again', 'why did you touch the lockfile',
    'No, use the other branch', 'no!!! not like that', 'why would you do that??', 'again?!! I said not to',
    'this is wrong!!!', "that's wrong.", "That's wrong again", "don't do that", 'not what I asked',
    'you did it again!!!', 'why did you delete the tests?', 'I told you already', 'why are you rewriting it?',
    'no. the other file', 'I do not understand what you are doing',
  ],
  ru: [
    'стоп!', 'стоп, не так', 'я же просил не трогать конфиг', 'я же сказал без тестов', 'забудь про это',
    'забудь, удали файл', 'не понял, что ты сделал', 'я не понимаю зачем ты это переписал', 'не могу понять что ты хочешь',
    'блин, опять та же ошибка', 'блин!!!', 'нет, не туда', 'нет!!! не так', 'зачем ты удалил тесты',
    'почему ты опять правишь конфиг?', 'зачем так сделал!!!', 'опять то же самое!!!', 'ещё раз!!! я же сказал',
    'не надо этого делать!!!', 'не нужно трогать базу!!!', 'неправильно!!!', 'хватит!!!', 'снова ошибка???',
    'это неправильно.', 'не так, как я просил', 'не делай так', 'ты опять всё сломал!!!', 'стоп!!!!! откати',
  ],
  uk: [
    'стоп!', 'я ж казав не чіпати тести', 'я ж просив без змін', 'забудь про це', 'не зрозумів, що ти зробив',
    'я не розумію навіщо ти це переписав', 'не можу зрозуміти що ти хочеш', 'блін!!!', 'блін, знову та сама помилка',
    'ні, не туди', 'ні!!! не так', 'навіщо ти видалив тести', 'чому ти знову міняєш конфіг?', 'навіщо так зробив!!!',
    'знову те саме!!!', 'ще раз!!! я ж казав', 'не треба цього робити!!!', 'не потрібно чіпати базу!!!',
    'неправильно!!!', 'досить!!!', 'знову помилка???', 'це неправильно.', 'не роби так', 'не так як я просив',
    'стоп!!!! поверни', 'ти знову все зламав!!!',
  ],
  es: ['ya te dije que no', 'olvídalo, bórralo', 'no hagas eso'],
  de: ['stopp! nicht so', 'ich habe doch gesagt, ohne Tests', 'vergiss es', 'nein, nicht so'],
  pt: ['eu já disse que não', 'esquece isso', 'não, não é assim', 'não entendi o que você fez'],
  fr: ["je t'ai déjà dit non", 'oublie ça', 'non, pas comme ça', "je n'ai pas compris ce que tu as fait"],
};

const BENIGN = {
  en: [
    'update the deck and recheck the stack', 'please commit and push', 'show me the file list', 'what is the status?',
    'yes, go ahead', 'ok do it', 'thanks, it works', 'why does the build fail?', 'why is this flag needed?',
    'there is no date column in the table', 'no access to the database from there', 'run the tests again, please',
    'check the stack once again', 'no need to change anything, all good', 'no problem, continue',
    'I told the client about the delay', 'I said hello to the team', 'stop the dev server', 'is the config wrong?',
    '<pasted_content id="a1">Turn 3 of 10 · $0.50 of $5.00 · 4 lines · 0 questions</pasted_content id="a1">',
    '[Image #1] look at this layout', 'Turn 7 of 90 · $0.40 of $6.00 · 3 lines · 2 questions',
    '- first step failed again\n- second step: no output\n- third step: wrong exit code',
    '│ step │ again │ no │\n│ build │ wrong │ no │', 'ok, but there is no time today', 'again, thanks for the help',
  ],
  ru: [
    'обнови презентацию и проверь стек', 'сделай коммит и пуш', 'покажи список файлов', 'какой сейчас статус?',
    'да, давай', 'ок, делай', 'спасибо, всё работает', 'почему падает сборка?', 'зачем нужен этот флаг?',
    'нет ли тут ошибок?', 'в таблице нет колонки с датой', 'там нет доступа к базе', 'ещё раз проверь стек, пожалуйста',
    'снова запусти тесты', 'опять запусти линтер', 'не нужно ничего менять, всё ок', 'нет проблем, продолжай',
    'остановись на этом шаге и покажи diff', 'так, начинай', 'как это работает?', 'почему так? объясни',
    '<pasted_content id="b2">Worker run: нет ошибок, опять запуск, снова ожидание</pasted_content id="b2">',
    '[Image #2] посмотри на макет', 'Turn 7 of 90 · $0.40 of $6.00 · 3 lines · 2 questions',
    '- шаг 1: нет доступа\n- шаг 2: снова ошибка\n- шаг 3: опять ошибка', 'ок, но нет времени сегодня',
  ],
  uk: [
    'онови презентацію і перевір стек', 'зроби коміт і пуш', 'покажи список файлів', 'який зараз статус?',
    'так, давай', 'добре, роби', 'дякую, все працює', 'чому падає збірка?', 'навіщо потрібен цей прапорець?',
    'у таблиці немає колонки з датою', 'там немає доступу до бази', 'ще раз перевір стек, будь ласка',
    'знову запусти тести', 'не потрібно нічого міняти, все гаразд', 'не треба поспішати, все гаразд',
    'зупинись на цьому кроці і покажи diff', 'як це працює?', 'чому так? поясни', 'ні проблем, продовжуй',
    '<pasted_content id="c3">Worker run: немає помилок, знову запуск, ще очікування</pasted_content id="c3">',
    '[Image #3] подивись на макет', 'Turn 7 of 90 · $0.40 of $6.00 · 3 lines · 2 questions',
    '- крок 1: немає доступу\n- крок 2: знову помилка\n- крок 3: знову помилка', 'добре, але сьогодні немає часу',
    'де лежить цей файл?',
  ],
  es: ['actualiza la presentación', 'sí, adelante', 'por qué falla la compilación?'],
  de: ['aktualisiere die Präsentation', 'ja, mach weiter', 'warum schlägt der Build fehl?'],
  pt: ['atualize a apresentação', 'sim, pode seguir', 'por que o build falha?'],
  fr: ['mets à jour la présentation', "oui, vas-y", 'pourquoi le build échoue ?'],
};

for (const [lang, list] of Object.entries(POSITIVE)) {
  test(`default phrases: ${lang} corrections fire (${list.length})`, () => {
    for (const text of list) assert.ok(fires(text), `${lang}: ${text}`);
  });
}

for (const [lang, list] of Object.entries(BENIGN)) {
  test(`default phrases: ${lang} benign texts stay quiet (${list.length})`, () => {
    for (const text of list) assert.equal(fires(text), false, `${lang}: ${text}`);
  });
}

test('default phrases: the tables are large enough', () => {
  for (const lang of ['en', 'ru', 'uk']) {
    assert.ok(POSITIVE[lang].length >= 25, lang);
    assert.ok(BENIGN[lang].length >= 25, lang);
  }
});

test('a question that only asks for information is not a correction, an emphasised one is', () => {
  assert.equal(fires('why is the build slow?'), false);
  assert.equal(fires('why is the build slow???'), true);
  assert.equal(fires('а это зачем?'), true);
});

test('pasted blocks and UI lines do not hide the typed words', () => {
  assert.equal(fires('<pasted_content id="x">Turn 3 of 10 · $0.50 of $5.00</pasted_content id="x"> стоп, не так'), true);
  assert.equal(fires('Turn 7 of 90 · $0.40 of $6.00 · 3 lines\n\nопять ошибка!!!'), true);
});

test('an approval opening does not turn a weak marker into a correction', () => {
  assert.equal(fires('да, снова запусти тесты!!'), false);
  assert.equal(fires('ok, again!!'), false);
});

test('the skips for subagent, meta and agent messages still hold with the default phrases', () => {
  const d = correction.create(DEFAULTS, deps);
  d.onEvent({ ...user('стоп!'), agent: 'subagent' });
  d.onEvent({ ...user('стоп!'), meta: true });
  d.onEvent(user('<teammate-message id="x">стоп!'));
  assert.equal(d.finish().findings.length, 0);
});
