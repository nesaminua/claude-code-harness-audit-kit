'use strict';

const { finding, addExposure } = require('./util');

const id = 'agent-usage-limit';
const title = 'An agent died on a model usage limit';
const severity = 'high';
const MODEL_RE = /^[A-Za-z0-9._-]{1,40}$/;

function create(config, deps) {
  const detector = { id, severity };
  const hits = new Map();
  const sessions = new Set();

  function onEvent(ev) {
    if (ev.session) sessions.add(ev.session);
    if (ev.kind !== 'usage_limit') return;
    const model = MODEL_RE.test(String(ev.model)) ? ev.model : 'unknown';
    const dedupe = `${ev.session}\u0000${model}\u0000${ev.agent || ''}`;
    if (!hits.has(dedupe)) hits.set(dedupe, { ev, model });
  }

  function finish() {
    const findings = [];
    const exposureByKey = new Map();
    for (const { ev, model } of hits.values()) {
      const key = `${id}:${model}`;
      findings.push(finding(detector, ev, {
        key, summary: `${ev.agent || 'an agent'} died on the ${model} usage limit`,
      }, deps));
      for (const s of sessions) addExposure(exposureByKey, key, s);
    }
    return { findings, exposedSessions: sessions, exposureByKey };
  }

  return { onEvent, finish };
}

module.exports = { id, title, severity, create };
