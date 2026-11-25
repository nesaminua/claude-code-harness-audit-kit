'use strict';

const { finding, addExposure, makeRedact } = require('./util');

const detector = {
  id: 'user-interrupt',
  title: 'User interrupted the assistant',
  severity: 'low',
};

const KEY = 'user-interrupt:esc';

function create(config, deps) {
  const { redact } = makeRedact(deps);
  const findings = [];
  const exposedSessions = new Set();
  const exposureByKey = new Map();
  let lastAssistant = '';

  return {
    onEvent(ev) {
      if (ev.kind === 'assistant_text') {
        lastAssistant = String(ev.text || '');
        return;
      }
      if (ev.kind !== 'user_text' || ev.agent === 'subagent' || ev.meta) return;
      exposedSessions.add(ev.session);
      addExposure(exposureByKey, KEY, ev.session);
      if (String(ev.text || '').startsWith('[Request interrupted by user')) {
        findings.push(finding(detector, ev, {
          key: KEY,
          summary: `interrupted after: ${redact(lastAssistant).slice(0, 160)}`,
          evidence: [lastAssistant],
        }, deps));
      }
      lastAssistant = '';
    },
    finish() {
      return { findings, exposedSessions, exposureByKey, warnings: [] };
    },
  };
}

module.exports = { ...detector, create };
