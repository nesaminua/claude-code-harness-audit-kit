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

const ELLIPSIS = '…';
const SHAPE_CAP = 160;
const SEPARATOR_RE = /^(?:&&|\|\||[;|&\n])/;
const ASSIGN_NAME_RE = /^([A-Z_][A-Z0-9_]{0,39})=/;
const PROGRAM_RE = /^[A-Za-z0-9._+-]{1,30}$/;
const SUBCOMMAND_RE = /^[a-z][a-z0-9-]{0,19}$/;
const LONG_FLAG_RE = /^--[a-z][a-z0-9-]{0,29}$/;
const SHORT_FLAG_RE = /^-[A-Za-z]{1,3}$/;
// How many leading bare words are subcommands. A program missing here shows none: its first word may be a value.
const SUBCOMMAND_DEPTH = {
  git: 1, npm: 1, pnpm: 1, yarn: 1, bun: 1, cargo: 1, go: 1, brew: 1, pip: 1, pip3: 1, apt: 1,
  systemctl: 1, make: 1, wrangler: 1, vercel: 1, claude: 1,
  gh: 2, docker: 2, kubectl: 2, aws: 2, gcloud: 2, az: 2, supabase: 2,
};

// Splits on unquoted separators; a token keeps its quotes, a separator is its own token.
function shellTokens(command) {
  const tokens = [];
  let cur = '';
  let quote = null;
  const flush = () => {
    if (cur) tokens.push({ text: cur });
    cur = '';
  };
  const text = String(command);
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < text.length) cur += text[(i += 1)];
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '\\' && i + 1 < text.length) {
      cur += ch + text[(i += 1)];
    } else if (/\s/.test(ch) && ch !== '\n') {
      flush();
    } else if (ch === '&' && (text[i - 1] === '>' || text[i - 1] === '<')) {
      cur += ch;
    } else if (SEPARATOR_RE.test(text.slice(i, i + 2))) {
      flush();
      const sep = text.startsWith('&&', i) || text.startsWith('||', i) ? text.slice(i, i + 2) : ch;
      tokens.push({ text: sep === '\n' ? ';' : sep, separator: true });
      i += sep.length - 1;
    } else {
      cur += ch;
    }
  }
  flush();
  return tokens;
}

const flagName = (text) => {
  const name = text.split('=')[0];
  return LONG_FLAG_RE.test(name) || SHORT_FLAG_RE.test(text) ? name : null;
};

// A flag takes the next bare word as its value; further bare words are positional and collapse to one marker.
function shapeOfSegment(tokens) {
  const out = [];
  const state = { program: null, depth: 0, flagged: false, valueNext: false, positional: false };
  for (const { text } of tokens) {
    const assign = ASSIGN_NAME_RE.exec(text);
    if (assign) {
      out.push(`${assign[1]}=${ELLIPSIS}`);
    } else if (state.program === null) {
      state.program = text.split(/[\\/]/).pop();
      state.depth = SUBCOMMAND_DEPTH[state.program] || 0;
      out.push(PROGRAM_RE.test(state.program) ? state.program : ELLIPSIS);
    } else if (flagName(text)) {
      out.push(flagName(text));
      Object.assign(state, { flagged: true, valueNext: !text.includes('='), positional: false });
    } else if (!state.flagged && state.depth > 0 && SUBCOMMAND_RE.test(text)) {
      out.push(text);
      state.depth -= 1;
    } else if (state.valueNext) {
      out.push(ELLIPSIS);
      state.valueNext = false;
    } else if (!state.positional) {
      out.push(ELLIPSIS);
      state.positional = true;
    }
  }
  return out.join(' ');
}

/** The command without any argument value: programs, subcommands and flag names only. */
function commandShape(command) {
  if (typeof command !== 'string' || !command) return '';
  const parts = [];
  let segment = [];
  const close = () => {
    if (segment.length) parts.push(shapeOfSegment(segment));
    segment = [];
  };
  for (const token of shellTokens(command.slice(0, 20000))) {
    if (token.separator) {
      close();
      parts.push(token.text);
    } else segment.push(token);
  }
  close();
  return parts.join(' ').slice(0, SHAPE_CAP);
}

const fileBase = (p) => String(p).split(/[\\/]/).pop().slice(0, 80);

/** What a detector may store about a tool call: the command shape, or the tool name and a file basename. */
function describeCall(name, input) {
  const tool = String(name || 'tool').slice(0, 40);
  if (tool === 'Bash') return commandShape(input && input.command) || tool;
  const file = input && (input.file_path || input.notebook_path);
  return typeof file === 'string' && file ? `${tool} ${fileBase(file)}` : tool;
}

function addExposure(map, key, session) {
  if (!session) return;
  const set = map.get(key) || new Set();
  set.add(session);
  map.set(key, set);
}

module.exports = { compileList, maskDigits, shortHook, finding, addExposure, makeRedact, redactKey, commandShape, describeCall };
