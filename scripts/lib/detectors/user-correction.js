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

function isSkipped(text, lastAssistant) {
  const trimmed = text.trim();
  if (trimmed.length > MAX_LENGTH || SKIP_PREFIX_RE.test(trimmed)) return true;
  return BARE_ANSWER_RE.test(trimmed) && OFFER_RE.test(lastAssistant);
}

function create(config = {}, deps) {
  const { compiled, warnings } = compileGroups(config.correctionPhrases);
  const findings = [];
  const exposedSessions = new Set();
  const fired = new Set();
  let lastAssistant = '';

  function onUserText(ev) {
    if (ev.agent === 'subagent' || ev.meta) return;
    const text = String(ev.text || '');
    const skipped = isSkipped(text, lastAssistant);
    lastAssistant = '';
    if (skipped) return;
    exposedSessions.add(ev.session);
    const hit = compiled.find(({ regexes }) => regexes.some((re) => re.test(text)));
    if (!hit) return;
    const key = `user-correction:${hit.group}`;
    fired.add(key);
    findings.push(finding(detector, ev, { key, summary: text, evidence: [text] }, deps));
  }

  return {
    onEvent(ev) {
      if (ev.kind === 'assistant_text') lastAssistant = String(ev.text || '');
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
