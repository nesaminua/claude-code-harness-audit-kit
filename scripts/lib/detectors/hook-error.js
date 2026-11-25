'use strict';

const { shortHook, finding, addExposure } = require('./util');

const id = 'hook-error';
const title = 'Hook crashed, timed out or failed without blocking';
const severity = 'medium';

function create(config, deps) {
  const detector = { id, severity };
  const findings = [];
  const exposedSessions = new Set();
  const exposureByKey = new Map();

  function expose(key, session) {
    if (!session) return;
    exposedSessions.add(session);
    addExposure(exposureByKey, key, session);
  }

  function onError(ev, key) {
    const first = String(ev.detail || '').split('\n').find((l) => l.trim()) || '';
    findings.push(finding(detector, ev, {
      key,
      hook: shortHook(ev.hook),
      severity: ev.type === 'crash' ? 'high' : 'medium',
      summary: `${ev.hookEvent} ${ev.hook}: ${ev.type} — ${first}`,
      evidence: [String(ev.detail || '')],
    }, deps));
  }

  function onEvent(ev) {
    if (ev.kind !== 'hook_error' && ev.kind !== 'hook_run') return;
    const key = `${id}:${shortHook(ev.hook)}`;
    expose(key, ev.session);
    if (ev.kind === 'hook_error') onError(ev, key);
  }

  return { onEvent, finish: () => ({ findings, exposedSessions, exposureByKey }) };
}

module.exports = { id, title, severity, create };
