'use strict';

const { compileList, finding, addExposure } = require('./util');

const detector = {
  id: 'user-correction',
  title: 'User corrected the assistant',
  severity: 'low',
};

const MAX_LENGTH = 400;
const SKIP_PREFIX_RE = /^(?:\/|!|<command-|<task-notification|<local-command|\[Request interrupted|Caveat:|<teammate-message|<agent-message|<cross-session-message)/;
const BARE_ANSWER_RE = /^(?:no|nope|нет|ні|nein|non|n[ãa]o|\d{1,2}|[a-z])[.!]*$/iu;
const OFFER_RE = /\?[\s)"»]*$|\([^)]*\b(?:yes|no|да|нет|так|ні)\b[^)]*\)\s*$|^\s*(?:\d+|[A-Ea-e])[.)]\s/imu;

const PASTE_RE = /<pasted_content[^>]{0,200}>[\s\S]{0,400}?(?:<\/pasted_content[^>]{0,200}>|$)/g;
const IMAGE_RE = /\[Image[^\]]{0,200}\]/g;
const ASSISTANT_CAP = 4096;
const UI_LINE_RE = /[│┃┆║]|^\s*Turn \d+ of \d+|\d+ of \d+ ·|\$\d+(?:\.\d+)? of \$/u;
const EMPHASIS_RE = /[!?]{2,}|!.*!.*!/s;
const QUESTION_END_RE = /\?["')»\s]*$/;
const CHALLENGE_END_RE = /(?:зачем|навіщо|чому|почему|why|por qué|warum|pourquoi)[\s!?]*$/iu;
const PROHIBIT_RE = /(?:не\s+(?:делай\w*|трогай\w*|добавляй\w*|смей\w*|пиши\w*|роби\w*|чіпай\w*)|нельзя|ни\s+в\s+коем|don'?t|do not|never|please stop)/iu;
const MIN_LINE_CHARS = 8;
const MIN_LIST_LINES = 3;
const MIN_LETTER_SHARE = 0.4;

// What the user typed himself: pasted blocks, image markers and UI or log lines are somebody else's words.
function ownWords(text) {
  if ((text.match(/^\s*[-*•]\s/gm) || []).length >= MIN_LIST_LINES) return '';
  const kept =text.replace(PASTE_RE, '\n').replace(IMAGE_RE, ' ').split('\n').filter((line) => {
    const dense = line.replace(/\s/g, '');
    if (UI_LINE_RE.test(line)) return false;
    if (dense.length < MIN_LINE_CHARS) return true;
    return (dense.match(/\p{L}/gu) || []).length / dense.length >= MIN_LETTER_SHARE;
  });
  return kept.join(' ').replace(/\s+/g, ' ').trim();
}

function compileGroups(phrases) {
  const groups = Array.isArray(phrases) ? { any: phrases } : phrases && typeof phrases === 'object' ? phrases : {};
  const compiled = [];
  const warnings = [];
  for (const [group, list] of Object.entries(groups)) {
    const result = compileList(list, 'iu');
    compiled.push({ group, regexes: result.compiled });
    warnings.push(...result.warnings);
  }
  return { compiled, warnings };
}

function firstHit(tier, text) {
  for (const { group, regexes } of tier) {
    for (const re of regexes) {
      const m = re.exec(text);
      if (m) return { group };
    }
  }
  return null;
}

function verdict(own, tiers, grants) {
  const hard = firstHit(tiers.strong, own);
  if (hard) return hard.group;
  const emphasis = EMPHASIS_RE.test(own);
  const question = QUESTION_END_RE.test(own) && !emphasis;
  const plain = firstHit(tiers.plain, own);
  if (plain && !question) return plain.group;
  const weak = firstHit(tiers.weak, own);
  if (!weak || grants.some((re) => re.test(own))) return null;
  const challenge = CHALLENGE_END_RE.test(own);
  if (question && !challenge) return null;
  return emphasis || challenge || PROHIBIT_RE.test(own) ? weak.group : null;
}

function isSkipped(text, lastAssistant) {
  const trimmed = text.trim();
  if (trimmed.length > MAX_LENGTH || SKIP_PREFIX_RE.test(trimmed)) return true;
  return BARE_ANSWER_RE.test(trimmed) && OFFER_RE.test(lastAssistant);
}

function create(config = {}, deps) {
  const plain = compileGroups(config.correctionPhrases);
  const strong = compileGroups(config.correctionStrongPhrases);
  const weak = compileGroups(config.correctionWeakPhrases);
  const grants = compileList(config.grantPhrases, 'iu');
  const tiers = { plain: plain.compiled, strong: strong.compiled, weak: weak.compiled };
  const warnings = [...plain.warnings, ...strong.warnings, ...weak.warnings, ...grants.warnings];
  const findings = [];
  const exposedSessions = new Set();
  const fired = new Set();
  let lastAssistant = '';

  function onUserText(ev) {
    if (ev.agent === 'subagent' || ev.meta) return;
    const text = String(ev.text || '');
    // A correction is short: judge the length before any regex sees the text.
    const tooLong = text.trim().length > MAX_LENGTH;
    const own = tooLong ? '' : ownWords(text);
    const skipped = !own || isSkipped(text, lastAssistant);
    lastAssistant = '';
    if (skipped) return;
    exposedSessions.add(ev.session);
    const group = verdict(own, tiers, grants.compiled);
    if (!group) return;
    const key = `user-correction:${group}`;
    fired.add(key);
    findings.push(finding(detector, ev, { key, summary: text, evidence: [text] }, deps));
  }

  return {
    onEvent(ev) {
      if (ev.kind === 'assistant_text') lastAssistant = String(ev.text || '').slice(-ASSISTANT_CAP);
      else if (ev.kind === 'user_text') onUserText(ev);
    },
    finish() {
      const exposureByKey = new Map();
      for (const key of fired) for (const s of exposedSessions) addExposure(exposureByKey, key, s);
      return { findings, exposedSessions, exposureByKey, warnings };
    },
  };
}

module.exports = { ...detector, create };
