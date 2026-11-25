'use strict';

const { maskDigits, finding, addExposure } = require('./util');

const id = 'tool-error-loop';
const title = 'Same tool error repeated';
const severity = 'medium';
const DEFAULT_THRESHOLD = 3;
const REJECT_RE = /^(The user doesn't want to proceed|User rejected)/;
const FAILURE_RE = /FAIL|Error|error:|ERR!/;
const FRAME_RE = /^(> \S|\s*RUN\s+v\d|Exit code \d+|curl: \(22\))/;
const LOCATION_RE = /(?<![\w./-])[\w./-]{1,256}\.\w{1,16}:\d{1,7}(?::\d{1,7})?/g;
const LINE_CAP = 4096;

// file:line stays verbatim: a linter walking down a file is progress, not a loop.
function maskKeepingLocations(line) {
  let out = '';
  let last = 0;
  for (const m of line.matchAll(LOCATION_RE)) {
    out += maskDigits(line.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + maskDigits(line.slice(last));
}

// The raw line, capped before any regex runs over it. Display text comes from here, never from the masked signature.
function errorLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter((l) => l && !FRAME_RE.test(l));
  return (lines.find((l) => FAILURE_RE.test(l)) || lines[0] || '').slice(0, LINE_CAP);
}

function errorSignature(text) {
  return maskKeepingLocations(errorLine(text)).replace(/\s+/g, ' ').slice(0, 240);
}

function create(config, deps) {
  const detector = { id, severity };
  const threshold = (config && config.thresholds && config.thresholds.toolErrorLoop) || DEFAULT_THRESHOLD;
  const uses = new Map();
  const seen = new Map();
  const emitted = new Set();
  const findings = [];
  const exposedSessions = new Set();
  const exposureByKey = new Map();

  function onResult(ev) {
    const text = String(ev.text || '');
    if (!ev.isError || REJECT_RE.test(text)) return;
    const use = uses.get(ev.toolUseId) || {};
    const key = `${id}:${use.name || 'unknown'}`;
    exposedSessions.add(ev.session);
    addExposure(exposureByKey, key, ev.session);
    const sig = errorSignature(text);
    const slot = `${ev.session}\u0000${sig}`;
    const prev = seen.get(slot) || { n: 0, messageId: null };
    // Calls sent together fail before the model sees any result: one attempt.
    if (use.messageId && prev.messageId === use.messageId) return;
    const n = prev.n + 1;
    seen.set(slot, { n, messageId: use.messageId || null });
    if (n >= threshold && !emitted.has(slot)) {
      emitted.add(slot);
      findings.push(finding(detector, ev, {
        key,
        summary: `same ${use.name || 'tool'} error ${n}x: ${errorLine(text).replace(/\s+/g, ' ')}`,
        evidence: [text],
      }, deps));
    }
  }

  function onEvent(ev) {
    if (ev.kind === 'tool_use') uses.set(ev.id, ev);
    else if (ev.kind === 'tool_result') onResult(ev);
  }

  return { onEvent, finish: () => ({ findings, exposedSessions, exposureByKey }) };
}

module.exports = { id, title, severity, create, errorSignature, errorLine };
