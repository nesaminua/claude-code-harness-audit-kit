'use strict';

const { finding, addExposure, describeCall } = require('./util');

const detector = {
  id: 'forbidden-pattern',
  title: 'Tool call matches a project-forbidden pattern',
  severity: 'medium',
};

function compileRules(list) {
  const rules = [];
  const warnings = [];
  for (const entry of Array.isArray(list) ? list : []) {
    try {
      if (!entry || !entry.id || !entry.tool || !entry.pattern) throw new Error('id, tool and pattern are required');
      rules.push({
        id: String(entry.id),
        field: entry.field || 'any',
        message: entry.message || entry.id,
        tool: new RegExp(entry.tool, 'u'),
        pattern: new RegExp(entry.pattern, 'u'),
      });
    } catch (err) {
      warnings.push(`invalid forbidden entry skipped: ${String((entry && entry.id) || '?').slice(0, 60)} (${err.message})`);
    }
  }
  return { rules, warnings };
}

const VALUE_CAP = 16384;

// Head and tail, so a pattern still sees both ends of a long command while a configured regex never runs over 400 KB.
const capValue = (s) => (s.length <= VALUE_CAP ? s : `${s.slice(0, VALUE_CAP / 2)} ${s.slice(-VALUE_CAP / 2)}`);

function fieldValue(field, input) {
  if (field === 'any') return capValue(JSON.stringify(input || {}));
  const v = input && input[field];
  return typeof v === 'string' ? capValue(v) : '';
}

function create(config = {}, deps) {
  const { rules, warnings } = compileRules(config.forbidden);
  const exposedSessions = new Set();
  const exposureByKey = new Map();
  const hits = new Map();

  return {
    onEvent(ev) {
      if (ev.kind !== 'tool_use') return;
      for (const rule of rules) {
        if (!rule.tool.test(ev.name || '')) continue;
        const key = `forbidden-pattern:${rule.id}`;
        addExposure(exposureByKey, key, ev.session);
        exposedSessions.add(ev.session);
        const value = fieldValue(rule.field, ev.input);
        if (!value || !rule.pattern.test(value)) continue;
        const slot = `${ev.session}\u0000${rule.id}`;
        const prev = hits.get(slot);
        if (prev) prev.count += 1;
        else hits.set(slot, { ev, rule, call: describeCall(ev.name, ev.input), count: 1 });
      }
    },
    finish() {
      const findings = [...hits.values()].map(({ ev, rule, call, count }) => finding(detector, ev, {
        key: `forbidden-pattern:${rule.id}`,
        summary: `${rule.message} — ${rule.id}: ${call}`,
        evidence: [`hits in session: ${count}`, `first call: ${call}`],
      }, deps));
      return { findings, exposedSessions, exposureByKey, warnings };
    },
  };
}

module.exports = { ...detector, create };
