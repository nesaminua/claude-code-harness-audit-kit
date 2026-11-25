'use strict';

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

// A heredoc operator anywhere (also inside quotes or a substitution) ends the shape: we never look for its terminator,
// because a quote inside the body can desynchronise any scanner. `<<<` (a here-string) is not one.
const HEREDOC_OP = /(?<!<)<<(?!<)/;

// A substitution body is its own quoting context. The scanners below return the index of the closing character,
// or -1 when they cannot prove a balanced end (an unclosed quote, a `case` pattern,
// too deep a nesting). The caller then masks everything from the opener to the end of the input: never a guess.
const MAX_NESTING = 24;

function backtickEnd(text, i) {
  for (let j = i + 1; j < text.length; j += 1) {
    if (text[j] === '\\') j += 1;
    else if (text[j] === '`') return /\bcase\s/.test(text.slice(i, j)) ? -1 : j;
  }
  return -1;
}

function doubleQuotedEnd(text, i, level) {
  for (let j = i + 1; j < text.length; j += 1) {
    const c = text[j];
    if (c === '\\') j += 1;
    else if (c === '"') return j;
    else if (c === '`' || (c === '$' && text[j + 1] === '(')) {
      const end = substitutionEnd(text, j, level + 1);
      if (end < 0) return -1;
      j = end;
    }
  }
  return -1;
}

const isCaseKeyword = (text, j) => /^case[ \t\n]/.test(text.slice(j, j + 5)) && (j === 0 || /[\s;|&(]/.test(text[j - 1]));

// Index of the ")" that closes the "$(" at text[i], tracking quotes, nested substitutions and subshell parens.
function parenEnd(text, i, level) {
  let depth = 1;
  for (let j = i + 2; j < text.length; j += 1) {
    const c = text[j];
    if (c === '\\') j += 1;
    else if (c === "'") {
      const close = text.indexOf("'", j + 1);
      if (close < 0) return -1;
      j = close;
    } else if (c === '"') {
      const end = doubleQuotedEnd(text, j, level);
      if (end < 0) return -1;
      j = end;
    } else if (c === '`' || (c === '$' && text[j + 1] === '(')) {
      const end = substitutionEnd(text, j, level + 1);
      if (end < 0) return -1;
      j = end;
    } else if (c === 'c' && isCaseKeyword(text, j)) return -1;
    else if (c === '(') depth += 1;
    else if (c === ')' && (depth -= 1) === 0) return j;
  }
  return -1;
}

function substitutionEnd(text, i, level = 0) {
  if (level > MAX_NESTING) return -1;
  return text[i] === '`' ? backtickEnd(text, i) : parenEnd(text, i, level);
}

const isSubstitutionStart = (text, i) => text[i] === '`' || (text[i] === '$' && text[i + 1] === '(');

// Appends the substitution marker and returns the index of its last character; unbalanced masks the rest of the input.
function appendSubstitution(text, i, append) {
  append(text[i] === '`' ? '`…`' : '$(…)');
  const end = substitutionEnd(text, i);
  return end < 0 ? text.length : end;
}

// Splits on unquoted separators; a token keeps its quotes, a separator is its own token.
// `$(…)` / backtick bodies never reach a token: they become one marker, and everything from a `<<` on is one marker.
function shellTokens(command) {
  const tokens = [];
  let cur = '';
  let quote = null;
  const flush = () => {
    if (cur) tokens.push({ text: cur });
    cur = '';
  };
  const whole = String(command);
  const heredocAt = whole.search(HEREDOC_OP);
  const text = heredocAt < 0 ? whole : whole.slice(0, heredocAt);
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && isSubstitutionStart(text, i)) {
        i = appendSubstitution(text, i, (marker) => { cur += marker; });
        continue;
      }
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < text.length) cur += text[(i += 1)];
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (isSubstitutionStart(text, i)) {
      i = appendSubstitution(text, i, (marker) => { cur += marker; });
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
  if (heredocAt >= 0) tokens.push({ text: ELLIPSIS, mask: true });
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
  for (const { text, mask } of tokens) {
    if (mask) {
      if (out[out.length - 1] !== ELLIPSIS) out.push(ELLIPSIS);
      continue;
    }
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

module.exports = { shellTokens, commandShape, describeCall };
