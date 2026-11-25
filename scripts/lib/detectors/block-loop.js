'use strict';

const { maskDigits, shortHook, finding, addExposure, describeCall } = require('./util');

const id = 'block-loop';
const title = 'Same hook blocked repeatedly with the same reason';
const severity = 'high';
const DEFAULT_THRESHOLD = 3;
const GAP_CALLS = 20;

function create(config, deps) {
  const detector = { id, severity };
  const threshold = (config && config.thresholds && config.thresholds.blockLoop) || DEFAULT_THRESHOLD;
  const calls = new Map();
  const counted = new Set();
  const counts = new Map();
  const emitted = new Set();
  const findings = [];
  const exposedSessions = new Set();
  const exposureByKey = new Map();
  let callNo = 0;
  // none -> tool (a call came after the last Stop block) -> passed (a user turn followed)
  let stopRound = 'none';

  function resetHook(hook) {
    for (const k of [...counts.keys()]) if (k.startsWith(`${hook}\u0000`)) counts.delete(k);
  }

  function onBlock(ev) {
    const hook = shortHook(ev.hook);
    const key = `${id}:${hook}`;
    exposedSessions.add(ev.session);
    addExposure(exposureByKey, key, ev.session);
    if (ev.toolUseId) {
      if (counted.has(ev.toolUseId)) return;
      counted.add(ev.toolUseId);
    }
    if (ev.hookEvent === 'Stop') {
      if (stopRound === 'passed') resetHook(hook);
      stopRound = 'none';
    }
    const sig = `${hook}\u0000${maskDigits(ev.reason)}`;
    const blocked = calls.get(ev.toolUseId);
    const messageId = (blocked || {}).messageId || null;
    const seen = counts.get(sig) || { n: 0, messageId: null, at: callNo };
    // Calls issued in one message cannot react to each other's blocks.
    if (messageId && messageId === seen.messageId) return;
    const n = (callNo - seen.at > GAP_CALLS ? 0 : seen.n) + 1;
    counts.set(sig, { n, messageId, at: callNo });
    const once = `${ev.session}\u0000${key}`;
    if (n >= threshold && !emitted.has(once)) {
      emitted.add(once);
      findings.push(finding(detector, ev, {
        key,
        hook,
        summary: `${hook} blocked ${n}x with the same reason: ${ev.reason}`,
        evidence: [String(ev.reason || ''), `blocked call: ${blocked ? describeCall(blocked.name, blocked.input) : 'unknown'}`],
      }, deps));
    }
  }

  function onEvent(ev) {
    if (ev.kind === 'tool_use') {
      callNo += 1;
      calls.set(ev.id, ev);
      if (stopRound === 'none') stopRound = 'tool';
    } else if (ev.kind === 'user_text') {
      if (stopRound === 'tool') stopRound = 'passed';
    } else if (ev.kind === 'block') {
      onBlock(ev);
    }
  }

  return { onEvent, finish: () => ({ findings, exposedSessions, exposureByKey }) };
}

module.exports = { id, title, severity, create };
