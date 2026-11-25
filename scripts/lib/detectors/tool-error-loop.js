'use strict';

const { maskDigits, finding, addExposure } = require('./util');

const id = 'tool-error-loop';
const title = 'Same tool error repeated';
const severity = 'medium';
const DEFAULT_THRESHOLD = 3;
const MAX_SIGNATURE = 240;
const REJECT_RE = /^(The user doesn't want to proceed|User rejected)/;
const LOCATION_RE = /(?<![\w./-])[\w./-]{1,256}\.\w{1,16}:\d{1,7}(?::\d{1,7})?/g;
const LINE_CAP = 4096;

// Lines that carry no failure: runner frames, banners and separators, passing rows.
const SKIP_RES = [
  /^> \S/, /^RUN\s+v\d/, /^Exit code \d+/, /^curl: \(22\)/,
  /^[=\-_*#~⎯─]{3,}.*[=\-_*#~⎯─]{3,}$/, /^[=\-_*#~⎯─]{5,}$/,
  /^[✔✓•·]\s/, /^(PASS|ok)\s/, /^ℹ\s/,
  // eslint's summary row names a count, not a failure: it is the same for every lint run.
  /^✖\s+\d+ problems?\b/,
];
const SUITE_HEADER_RE = /^[✖✗×]\s*failing tests?:?$/i;
const FAIL_RE = /^(?:FAIL|FAILED)\b/;
const MARK_RE = /^[✖✗×]\s+\S/;
const BODY_RE = /^[●×✖✗]\s+\S/;
const STRONG_RES = [
  /\b\w*Error\b(?:\s*\[\w+\])?:/, /\berror\[E\d+\]/, /\berror TS\d+/, /\bERR!/, /^E\s+\S/, /\berror:/,
  /\b(?:Traceback|panicked at|Cannot find module)\b/,
];
// A traceback's own first line is the same for every script; its last line names the exception.
const PY_EXCEPTION_RE = /^[\w.]*(?:Error|Exception|Exit|Interrupt)\b/;
const WARNING_RE = /\bwarning\b/i;
const SOFT_RE = /^[\w-]+-(?:guard|gate):|\b(?:Can'?t|can not|failed|blocked|not found|No such file|[Pp]ermission denied|denied|refused|[Ii]solated in the worktree|No \w+ found|Cannot|Could not|Unable to|timed out|does not exist|did not finish|exceeds (?:the )?maximum|ENOENT|EACCES|ECONN\w+)\b/;

const VOLATILE = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
  [/\b[0-9a-f]{7,40}\b/g, '<hex>'],
  [/(?:\/private)?\/(?:tmp|var\/folders)\/\S+/g, '<tmp>'],
  [/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+/g, '<host>'],
];

// file:line stays verbatim: a linter walking down a file is progress, not a loop.
function maskKeepingLocations(line) {
  let out = '';
  let last = 0;
  for (const m of line.matchAll(LOCATION_RE)) {
    out += maskDigits(line.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + maskDigits(line.slice(last));
}

function collapse(line) {
  const stable = VOLATILE.reduce((s, [re, to]) => s.replace(re, to), line);
  return maskKeepingLocations(stable).replace(/\s+/g, ' ').trim();
}

// Every line is capped before any regex runs over it: a 200 KB line must not cost seconds.
function usableLines(text) {
  return String(text || '').split('\n').map((l) => l.trim().slice(0, LINE_CAP)).filter((l) => l && !SKIP_RES.some((re) => re.test(l)));
}

// The first failure of the output, named by the most specific line it prints.
function failureHead(lines) {
  // FAIL lines name a test more completely than the x marker above them, so they win when both exist.
  const i = lines.findIndex((l) => FAIL_RE.test(l));
  if (i >= 0) {
    const next = lines[i + 1];
    return next && BODY_RE.test(next) ? `${lines[i]} ${next}` : lines[i];
  }
  const mark = lines.find((l) => MARK_RE.test(l) && !SUITE_HEADER_RE.test(l));
  if (mark) return mark;
  if (lines.includes('Traceback (most recent call last):')) return lines.filter((l) => PY_EXCEPTION_RE.test(l)).pop() || null;
  return lines.find((l) => STRONG_RES.some((re) => re.test(l))) || lines.find((l) => SOFT_RE.test(l) && !WARNING_RE.test(l)) || null;
}

// The raw line that names the failure: display text comes from here, never from the masked signature.
function errorLine(text) {
  return failureHead(usableLines(text)) || '';
}

function errorSignature(text) {
  const head = errorLine(text);
  if (!head) return null;
  const sig = collapse(head).slice(0, MAX_SIGNATURE);
  return sig || null;
}

function create(config, deps) {
  const detector = { id, severity };
  const threshold = (config && config.thresholds && config.thresholds.toolErrorLoop) || DEFAULT_THRESHOLD;
  const uses = new Map();
  const seen = new Map();
  const emitted = new Set();
  const findings = [];
  const exposedSessions = new Set();
  const exposureByKey = new Map();

  function onResult(ev) {
    const text = String(ev.text || '');
    if (!ev.isError || REJECT_RE.test(text)) return;
    const use = uses.get(ev.toolUseId) || {};
    const key = `${id}:${use.name || 'unknown'}`;
    exposedSessions.add(ev.session);
    addExposure(exposureByKey, key, ev.session);
    const sig = errorSignature(text);
    if (!sig) return;
    const slot = `${ev.session}\u0000${sig}`;
    const prev = seen.get(slot) || { n: 0, messageId: null };
    // Calls sent together fail before the model sees any result: one attempt.
    if (use.messageId && prev.messageId === use.messageId) return;
    const n = prev.n + 1;
    seen.set(slot, { n, messageId: use.messageId || null });
    if (n >= threshold && !emitted.has(slot)) {
      emitted.add(slot);
      findings.push(finding(detector, ev, {
        key,
        summary: `same ${use.name || 'tool'} error ${n}x: ${errorLine(text).replace(/\s+/g, ' ')}`,
        evidence: [text],
      }, deps));
    }
  }

  function onEvent(ev) {
    if (ev.kind === 'tool_use') uses.set(ev.id, ev);
    else if (ev.kind === 'tool_result') onResult(ev);
  }

  return { onEvent, finish: () => ({ findings, exposedSessions, exposureByKey }) };
}

module.exports = { id, title, severity, create, errorSignature, errorLine };
