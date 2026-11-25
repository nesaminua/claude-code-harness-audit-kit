'use strict';

const { compileList, shortHook, finding, addExposure } = require('./util');

const detector = {
  id: 'block-bypassed',
  title: 'Override used right after a hook block',
  severity: 'high',
};

const ARMING = new Set(['PreToolUse', 'PermissionRequest']);
const GRANT_WINDOW = 5;
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|\S*)\s*/;
const COMMIT_N_RE = /\bgit\s+(?:-\S+\s+)*commit\b[^;&|\n]*\s-[a-zA-Z]*n[a-zA-Z]*(?=\s|$)/;

function envAssignments(command) {
  const names = [];
  for (const segment of String(command).split(/&&|\|\||[;|\n(]/)) {
    let rest = segment.trim();
    for (let m = ASSIGN_RE.exec(rest); m; m = ASSIGN_RE.exec(rest)) {
      names.push(m[1]);
      rest = rest.slice(m[0].length);
    }
  }
  return names;
}

function create(config = {}, deps) {
  const { compiled: patterns, warnings: patternWarnings } = compileList(config.bypassPatterns);
  const { compiled: grants, warnings: grantWarnings } = compileList(config.grantPhrases);
  const warnings = [...patternWarnings, ...grantWarnings];
  const findings = [];
  const exposedSessions = new Set();
  const exposureByKey = new Map();
  let calls = 0;
  let lastBlock = null;
  let lastGrantAt = null;
  let pending = null;

  function overrideReason(input, reason) {
    const command = (input && input.command) || '';
    if (/(?:^|\s)--no-verify\b/.test(command)) return '--no-verify';
    if (COMMIT_N_RE.test(command)) return 'git commit -n';
    if (input && input.dangerouslyDisableSandbox === true) return 'dangerouslyDisableSandbox';
    const named = envAssignments(command).find((n) => String(reason).includes(n));
    if (named) return `${named}=…`;
    const subject = command || JSON.stringify(input || {});
    const hit = patterns.find((re) => re.test(subject));
    return hit ? `pattern ${hit.source}` : null;
  }

  function settle() {
    if (!pending) return;
    findings.push(pending);
    pending = null;
  }

  function onToolUse(ev) {
    settle();
    calls += 1;
    if (!lastBlock) return;
    const lb = lastBlock;
    lastBlock = null;
    if (lastGrantAt !== null && calls - lastGrantAt <= GRANT_WINDOW) return;
    const why = overrideReason(ev.input, lb.reason);
    if (!why) return;
    const command = (ev.input && ev.input.command) || JSON.stringify(ev.input || {});
    pending = {
      toolUseId: ev.id,
      finding: finding(detector, ev, {
        key: `block-bypassed:${shortHook(lb.hook)}`,
        hook: shortHook(lb.hook),
        summary: `after ${shortHook(lb.hook)} block the next call used an override (${why}): ${command.slice(0, 120)}`,
        evidence: [`block reason: ${String(lb.reason).slice(0, 200)}`, `override call: ${command}`],
      }, deps),
    };
  }

  function onBlock(ev) {
    if (pending && pending.toolUseId === ev.toolUseId) pending = null;
    if (!ARMING.has(ev.hookEvent)) return;
    const key = `block-bypassed:${shortHook(ev.hook)}`;
    addExposure(exposureByKey, key, ev.session);
    exposedSessions.add(ev.session);
    lastBlock = { hook: ev.hook, reason: ev.reason };
    lastGrantAt = null;
  }

  return {
    onEvent(ev) {
      if (ev.kind === 'tool_use') onToolUse(ev);
      else if (ev.kind === 'block') onBlock(ev);
      else if (ev.kind === 'user_text' && lastBlock && grants.some((re) => re.test(ev.text || ''))) lastGrantAt = calls;
    },
    finish() {
      if (pending) {
        findings.push(pending.finding);
        pending = null;
      }
      return { findings, exposedSessions, exposureByKey, warnings };
    },
  };
}

module.exports = { ...detector, create };
