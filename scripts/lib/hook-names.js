'use strict';

// One pass over the command, no backtracking over its length: the SessionStart hook loads this on its
// hot path, and a regex over a long delimiter-free run was quadratic (78 s of a 90 s three-day audit).
// Built-ins only.

const INTERPRETERS = new Set([
  'node', 'nodejs', 'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd', 'ruby', 'perl',
  'php', 'deno', 'bun', 'npx', 'uvx', 'uv', 'tsx', 'ts-node', 'env', 'sudo', 'time', 'exec', 'nohup', 'command', 'go',
]);
const RUNNER_ARGS = new Set(['run', 'exec', 'x', 'dlx', 'tool']);
const SKIPPED_SEGMENTS = new Set(['cd', 'export', 'set', 'unset', 'source', '.', 'echo', 'true', ':']);
const SEPARATORS = new Set(['&&', '||', ';', '|']);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const EXT_RE = /^(.+?)\.[A-Za-z][A-Za-z0-9]{0,5}$/;
const BARE_RE = /^[A-Za-z0-9._-]+$/;
const PATH_SEP_RE = /[\\/]/;
const MAX_NAME = 80;

function words(command) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  const flush = () => {
    if (has || cur !== '') out.push(cur);
    cur = '';
    has = false;
  };
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      flush();
    } else {
      cur += ch;
    }
  }
  flush();
  return out;
}

function segments(list) {
  const out = [[]];
  for (const w of list) {
    if (SEPARATORS.has(w)) out.push([]);
    else out[out.length - 1].push(w);
  }
  return out.filter((s) => s.length > 0);
}

const baseOf = (w) => w.slice(Math.max(w.lastIndexOf('/'), w.lastIndexOf('\\')) + 1);

function isInterpreter(base) {
  const key = base.toLowerCase().replace(/\.exe$/, '');
  return INTERPRETERS.has(key) || /^(?:python|pypy)[\d.]*$/.test(key);
}

// Priority inside one command: a file with an extension, then a path without one, then a bare binary.
function nameOfSegment(seg) {
  const args = seg.filter((w) => !ASSIGNMENT_RE.test(w));
  if (args.length === 0 || SKIPPED_SEGMENTS.has(args[0])) return null;
  let afterInterpreter = false;
  let pathy = null;
  let bare = null;
  for (const w of args) {
    const base = baseOf(w);
    if (w.startsWith('-') || base === '') continue;
    if (isInterpreter(base)) {
      afterInterpreter = true;
      continue;
    }
    if (afterInterpreter && RUNNER_ARGS.has(base)) continue;
    afterInterpreter = false;
    const ext = EXT_RE.exec(base);
    if (ext) return ext[1];
    if (pathy === null && PATH_SEP_RE.test(w)) pathy = base;
    else if (bare === null && BARE_RE.test(base)) bare = base;
  }
  return pathy || bare;
}

function scriptName(command) {
  if (typeof command !== 'string') return null;
  for (const seg of segments(words(command))) {
    const name = nameOfSegment(seg);
    if (name && name.length <= MAX_NAME) return name;
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
