'use strict';

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

function finding(detector, ev, fields, deps) {
  const { redact, truncate } = makeRedact(deps);
  const clean = (s, n) => truncate(redact(String(s || '')), n);
  return {
    rule: detector.id,
    severity: fields.severity || detector.severity,
    key: fields.key,
    session: String(ev.session || '').slice(0, 8),
    line: ev.line ?? null,
    ts: ev.ts || null,
    hook: fields.hook || null,
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

module.exports = { compileList, maskDigits, shortHook, finding, addExposure, makeRedact };
