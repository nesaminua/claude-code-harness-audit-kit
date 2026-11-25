'use strict';

const { shellTokens, commandShape, describeCall } = require('./command-shape');

function compileList(list, flags = 'iu') {
  const compiled = [];
  const warnings = [];
  for (const source of Array.isArray(list) ? list : []) {
    try {
      compiled.push(new RegExp(source, flags));
    } catch (err) {
      warnings.push(`invalid pattern skipped: ${String(source).slice(0, 80)} (${err.message})`);
    }
  }
  return { compiled, warnings };
}

const maskDigits = (text) => String(text || '').replace(/\d+/g, '#');

function shortHook(name) {
  const s = String(name || '').trim();
  if (!s) return 'unknown-hook';
  const file = s.split(/[\\/]/).pop();
  return file.replace(/\.(c?js|mjs|ts|py|sh|ps1)$/i, '').slice(0, 60);
}

function makeRedact(deps) {
  if (deps && typeof deps.redact === 'function') return deps;
  const lib = require('../redact');
  return { redact: lib.redact, truncate: lib.truncate };
}

// A key is `<rule>:<hook or text>`; the part after the first colon can come from transcript text.
function redactKey(key, redact = makeRedact().redact) {
  const s = String(key ?? '');
  const i = s.indexOf(':');
  return i < 0 ? s : s.slice(0, i + 1) + redact(s.slice(i + 1));
}

function finding(detector, ev, fields, deps) {
  const { redact, truncate } = makeRedact(deps);
  const clean = (s, n) => truncate(redact(String(s || '')), n);
  return {
    rule: detector.id,
    severity: fields.severity || detector.severity,
    key: redactKey(fields.key, redact),
    session: String(ev.session || '').slice(0, 8),
    line: ev.line ?? null,
    ts: ev.ts || null,
    hook: fields.hook ? redact(String(fields.hook)) : null,
    summary: clean(fields.summary, 200),
    evidence: (fields.evidence || []).slice(0, 3).map((e) => clean(e, 300)),
  };
}

function addExposure(map, key, session) {
  if (!session) return;
  const set = map.get(key) || new Set();
  set.add(session);
  map.set(key, set);
}

module.exports = {
  compileList, maskDigits, shortHook, finding, addExposure, makeRedact, redactKey,
  shellTokens, commandShape, describeCall,
};
