'use strict';

// Scanned per segment: one regex over the whole string is quadratic on a long run without delimiters
// (78 s of a 90 s three-day audit). Built-ins only: the SessionStart hook loads this on its hot path.
const SEGMENT_RE = /[^\s/'"\\]+(?=([\s'"\\/])|$)/g;
const SCRIPT_SEGMENT_RE = /^(.+?)\.(?:[cm]?js|ts|py|sh)$/;
const SCRIPT_END_RE = /^[\s'"]$/;

function scriptName(command) {
  for (const seg of String(command || '').matchAll(SEGMENT_RE)) {
    const next = seg[1];
    if (next !== undefined && !SCRIPT_END_RE.test(next)) continue;
    const m = SCRIPT_SEGMENT_RE.exec(seg[0]);
    if (m) return m[1];
  }
  return null;
}

function hookNames(settingsJson) {
  const settings = typeof settingsJson === 'string' ? JSON.parse(settingsJson) : settingsJson || {};
  const names = new Set();
  const events = settings.hooks && typeof settings.hooks === 'object' ? Object.values(settings.hooks) : [];
  const groups = events.flatMap((g) => (Array.isArray(g) ? g : []));
  const hooks = groups.flatMap((g) => (g && Array.isArray(g.hooks) ? g.hooks : []));
  for (const h of hooks) {
    const name = scriptName(h && h.command);
    if (name) names.add(name);
  }
  return names;
}

module.exports = { scriptName, hookNames };
