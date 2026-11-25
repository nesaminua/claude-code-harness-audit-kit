'use strict';

const { finding, addExposure } = require('./util');

const id = 'subagent-max-turns';
const title = 'A subagent ran out of turns before finishing';
const severity = 'medium';
const JUDGE_PROMPT_RE = /^\s*You triage findings from an audit of an AI coding assistant harness/;
const CHILD_MARKER = 'HARNESS_AUDIT_KIT_CHILD';
const TYPE_RE = /^[A-Za-z0-9._-]{1,40}$/;
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

// The type becomes part of a queue key and a SessionStart line: only a plain identifier passes.
const typeOf = (raw) => (typeof raw === 'string' && TYPE_RE.test(raw) ? raw : 'agent');
const carriesMarker = (ev) => {
  if (ev.kind === 'user_text' || ev.kind === 'assistant_text') return String(ev.text).includes(CHILD_MARKER);
  return ev.kind === 'tool_use' && JSON.stringify(ev.input || {}).includes(CHILD_MARKER);
};

function create(config, deps) {
  const detector = { id, severity };
  const hits = [];
  const exposure = [];
  let sawUserText = false;
  let judgeRun = false;
  let marker = false;
  // `claude -p --max-turns N` (entrypoint sdk-*) hits its limit by design.
  let headless = false;

  function onEvent(ev) {
    if (typeof ev.entrypoint === 'string' && ev.entrypoint.startsWith('sdk')) headless = true;
    if (ev.kind === 'max_turns') hits.push(ev);
    if (ev.kind === 'user_text' && !sawUserText) {
      sawUserText = true;
      judgeRun = JUDGE_PROMPT_RE.test(ev.text);
    }
    if (carriesMarker(ev)) marker = true;
    if (ev.kind !== 'tool_use') return;
    if (ev.agent === 'subagent') exposure.push([`${id}:agent`, ev.session]);
    if (SPAWN_TOOLS.has(ev.name)) {
      exposure.push([`${id}:agent`, ev.session]);
      exposure.push([`${id}:${typeOf(ev.input && ev.input.subagent_type)}`, ev.session]);
    }
  }

  function finish() {
    const exposedSessions = new Set();
    const exposureByKey = new Map();
    for (const [key, session] of exposure) {
      if (!session) continue;
      exposedSessions.add(session);
      addExposure(exposureByKey, key, session);
    }
    if (judgeRun || marker || headless) return { findings: [], exposedSessions: new Set(), exposureByKey: new Map() };
    const findings = hits.map((ev) => {
      const type = typeOf(ev.agentType);
      return finding(detector, ev, { key: `${id}:${type}`, summary: `${type === 'agent' ? 'an agent' : type} hit its max turns` }, deps);
    });
    return { findings, exposedSessions, exposureByKey };
  }

  return { onEvent, finish };
}

module.exports = { id, title, severity, create };
