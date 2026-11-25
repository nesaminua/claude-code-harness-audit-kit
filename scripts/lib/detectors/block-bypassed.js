'use strict';

const { compileList, shortHook, finding, addExposure, describeCall } = require('./util');

const detector = {
  id: 'block-bypassed',
  title: 'Override used right after a hook block',
  severity: 'high',
};

const ARMING = new Set(['PreToolUse', 'PermissionRequest']);
const GRANT_WINDOW = 5;
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|\S*)\s*/;
const COMMIT_N_RE = /\bgit\s{1,8}(?:-\S{1,40}\s{1,8}){0,8}commit\b[^;&|\n]{0,2048}\s-[a-zA-Z]{0,8}n[a-zA-Z]{0,8}(?=\s|$)/;
const COMMAND_CAP = 4096;
const GRANT_TEXT_CAP = 1000;

// Head and tail: the flags that matter sit at either end of a long command, the middle is a message body.
const capCommand = (command) => {
  const s = String(command || '');
  return s.length <= COMMAND_CAP ? s : `${s.slice(0, COMMAND_CAP / 2)} ${s.slice(-COMMAND_CAP / 2)}`;
};

const SHAPE_RE = /(?:_OK|_SKIP|SKIP_|_FORCE|FORCE_|_BYPASS|_DISABLE|NO_VERIFY)/;
const QUOTED_RE = /'[^']*'|"[^"]*"/g;

const AGENT_MESSAGE_RE = /^\s*<(?:teammate-message|agent-message|cross-session-message)/;
const isHuman = (ev) => ev.agent !== 'subagent' && !ev.meta && !AGENT_MESSAGE_RE.test(ev.text || '');

const stripQuoted =(command) => String(command).replace(QUOTED_RE, '');

function namedInReason(name, reason) {
  return new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(String(reason));
}

function envAssignments(command) {
  const names = [];
  for (const segment of String(command).split(/&&|\|\||[;|\n(]/)) {
    let rest = segment.trim().replace(/^export\s+/, '');
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
  const pending = new Map();

  function overrideReason(input, reason) {
    const command = capCommand(input && input.command);
    const bare = stripQuoted(command);
    if (/(?:^|\s)--no-verify\b/.test(bare)) return '--no-verify';
    if (COMMIT_N_RE.test(bare)) return 'git commit -n';
    if (input && input.dangerouslyDisableSandbox === true) return 'dangerouslyDisableSandbox';
    const named = envAssignments(bare).find((n) => SHAPE_RE.test(n) && namedInReason(n, reason));
    if (named) return `${named}=…`;
    const subject = command || capCommand(JSON.stringify(input || {}));
    const hit = patterns.find((re) => re.test(subject));
    return hit ? `pattern ${hit.source}` : null;
  }

  function settle(id, ran) {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    if (ran) findings.push(item.finding);
  }

  function onToolUse(ev) {
    calls += 1;
    if (!lastBlock) return;
    const lb = lastBlock;
    lastBlock = null;
    if (lastGrantAt !== null && calls - lastGrantAt <= GRANT_WINDOW) return;
    const why = overrideReason(ev.input, lb.reason);
    if (!why) return;
    const call = describeCall(ev.name, ev.input);
    pending.set(ev.id, {
      finding: finding(detector, ev, {
        key: `block-bypassed:${shortHook(lb.hook)}`,
        hook: shortHook(lb.hook),
        summary: `after ${shortHook(lb.hook)} block the next call used an override (${why}): ${call}`,
        evidence: [`block reason: ${lb.reason}`, `override call: ${call}`],
      }, deps),
    });
  }

  function onBlock(ev) {
    settle(ev.toolUseId, !ARMING.has(ev.hookEvent));
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
      else if (ev.kind === 'tool_result') settle(ev.toolUseId, true);
      else if (ev.kind === 'user_text' && lastBlock && isHuman(ev) && grants.some((re) => re.test(String(ev.text || '').slice(0, GRANT_TEXT_CAP)))) lastGrantAt = calls;
    },
    finish() {
      for (const item of pending.values()) findings.push(item.finding);
      pending.clear();
      return { findings, exposedSessions, exposureByKey, warnings };
    },
  };
}

module.exports = { ...detector, create };
