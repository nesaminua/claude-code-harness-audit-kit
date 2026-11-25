'use strict';

const { shortHook, finding, addExposure, describeCall } = require('./util');

const id = 'retry-verbatim';
const title = 'Blocked call retried with identical input';
const severity = 'medium';
const REFUSING = new Set(['PreToolUse', 'PermissionRequest']);

function create(config, deps) {
  const detector = { id, severity };
  const calls = new Map();
  const findings = [];
  const exposedSessions = new Set();
  const exposureByKey = new Map();
  let pending = null;

  function onEvent(ev) {
    if (ev.kind === 'tool_use') {
      calls.set(ev.id, ev);
      // A retry is the very next call; any later call clears the window.
      if (pending && pending.name === ev.name && pending.inputHash === ev.inputHash) {
        findings.push(finding(detector, ev, {
          key: pending.key,
          hook: pending.hook,
          summary: `${pending.hook} block retried with identical ${ev.name} input: ${describeCall(ev.name, ev.input)}`,
          evidence: [`reason: ${pending.reason}`, `retried call: ${describeCall(ev.name, ev.input)}`],
        }, deps));
      }
      pending = null;
    } else if (ev.kind === 'block' && REFUSING.has(ev.hookEvent)) {
      const key = `${id}:${shortHook(ev.hook)}`;
      exposedSessions.add(ev.session);
      addExposure(exposureByKey, key, ev.session);
      const blocked = calls.get(ev.toolUseId);
      pending = blocked
        ? { name: blocked.name, inputHash: blocked.inputHash, key, hook: shortHook(ev.hook), reason: ev.reason }
        : null;
    }
  }

  return { onEvent, finish: () => ({ findings, exposedSessions, exposureByKey }) };
}

module.exports = { id, title, severity, create };
