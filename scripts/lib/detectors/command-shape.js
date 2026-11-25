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

const HEREDOC_RE = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z_][A-Za-z0-9_]*))/;

function heredocAt(text, i) {
  if (text[i + 2] === '<' || text[i - 1] === '<') return null;
  const m = HEREDOC_RE.exec(text.slice(i, i + 200));
  return m ? { length: m[0].length, term: m[2] ?? m[3] ?? m[4], strip: m[1] === '-' } : null;
}

// Position after the last terminator line; an unterminated body runs to the end of the input.
function skipHeredocBodies(text, from, pending) {
  let pos = from;
  for (const { term, strip } of pending) {
    while (pos < text.length) {
      const end = text.indexOf('\n', pos);
      const line = text.slice(pos, end < 0 ? text.length : end).replace(/\r$/, '');
      pos = end < 0 ? text.length : end + 1;
      if ((strip ? line.replace(/^\t+/, '') : line) === term) break;
    }
  }
  return pos;
}

// Index of the character that closes a `$(` or backtick body, or the end of the input when it never closes.
function substitutionEnd(text, i) {
  if (text[i] === '`') {
    for (let j = i + 1; j < text.length; j += 1) {
      if (text[j] === '\\') j += 1;
      else if (text[j] === '`') return j;
    }
    return text.length;
  }
  let depth = 1;
  for (let j = i + 2; j < text.length; j += 1) {
    const c = text[j];
    if (c === '\'' || c === '"') {
      const close = text.indexOf(c, j + 1);
      if (close < 0) return text.length;
      j = close;
    } else if (c === '(') depth += 1;
    else if (c === ')' && (depth -= 1) === 0) return j;
  }
  return text.length;
}

// Splits on unquoted separators; a token keeps its quotes, a separator is its own token.
// Heredoc bodies and `$(…)` / backtick bodies never reach a token: they become one marker.
function shellTokens(command) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let pending = [];
  const flush = () => {
    if (cur) tokens.push({ text: cur });
    cur = '';
  };
  const text = String(command);
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const heredoc = !quote && ch === '<' ? heredocAt(text, i) : null;
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < text.length) cur += text[(i += 1)];
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (heredoc) {
      flush();
      pending = [...pending, heredoc];
      i += heredoc.length - 1;
    } else if (ch === '\n' && pending.length) {
      flush();
      i = skipHeredocBodies(text, i + 1, pending) - 1;
      pending = [];
      tokens.push({ text: ELLIPSIS });
      if (i + 1 < text.length) tokens.push({ text: ';', separator: true });
    } else if (ch === '`' || (ch === '$' && text[i + 1] === '(')) {
      cur += ch === '`' ? '`…`' : '$(…)';
      i = substitutionEnd(text, i);
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

module.exports = { shellTokens, commandShape, describeCall };
