'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { scriptName, hookNames } = require('./hook-names.js');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const MID_EDIT_CALLS = 10;
const SLEEP_FACTOR = 50;
const EVENTS = 'PreToolUse|PostToolUse|Stop|UserPromptSubmit|PermissionRequest';

const PREFIXED_RE = new RegExp(`^(${EVENTS})(:\\w+)? hook (?:error|blocking error):?\\s*`);
const BRACKET_RE = /^\S+ hook \w+:?\s*\[([^\]]*)\]:?\s*/;
const BANNER_RE = /^[^\w\s]{0,3}\s*([A-Z][A-Z0-9.]*(?:[ -][A-Z][A-Z0-9.]*)+)(?:\s*\([^)]*\))?\s*(?::|\u2014|-)/u;
const GENERIC_FIRST = new Set(['ERROR', 'FAILED', 'FATAL', 'EXCEPTION', 'WARNING', 'ERR']);
const GENERIC_TAIL_RE = /[ -](?:ERRORS?|EXCEPTION|WARNINGS?|FAILURE|FAILED|FATAL)$/;
const HOOK_NAME_RE = /^([a-z0-9]+(?:-[a-z0-9]+)+):\s/;
const CRASH_RE = /^\s*(?:\w*Error|TypeError|ReferenceError|SyntaxError):|Traceback \(most recent call last\)|Cannot find module/;
const BULLET_RE = /^\s*[-*\u2022]/;
const QUOTED_RE = /"[^"\n]*"|'[^'\n]*'|\u00AB[^\u00BB\n]*\u00BB|`[^`\n]*`/g;
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

const RAN_TYPES = new Set(['hook_success', 'hook_non_blocking_error', 'hook_cancelled']);
const isMeta = (ev) => !!(ev.isMeta || ev.isCompactSummary);

const safeReaddir =(dir) => {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
};
const mtimeOf = (file) => {
  try { return fs.statSync(file).mtimeMs; } catch { return -1; }
};

function listTranscripts({ projectsDir, sinceMs = 0 }) {
  const out = [];
  const push = (file, kind, project) => {
    if (mtimeOf(file) >= sinceMs) out.push({ file, kind, project });
  };
  for (const proj of safeReaddir(projectsDir)) {
    if (!proj.isDirectory() || proj.name === 'memory') continue;
    const projDir = path.join(projectsDir, proj.name);
    for (const ent of safeReaddir(projDir)) {
      const p = path.join(projDir, ent.name);
      if (ent.isFile() && ent.name.endsWith('.jsonl')) push(p, 'main', proj.name);
      else if (ent.isDirectory() && ent.name !== 'memory') {
        const sub = path.join(p, 'subagents');
        for (const f of safeReaddir(sub)) {
          if (f.isFile() && f.name.endsWith('.jsonl')) push(path.join(sub, f.name), 'subagent', proj.name);
        }
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const blocksOf = (ev) => {
  const c = ev.message && ev.message.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c : [];
};

function resultText(b) {
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) return b.content.map((c) => (c && c.text) || '').join('\n');
  return '';
}

function crashed(stderr) {
  return String(stderr || '').split('\n').some((l) => !BULLET_RE.test(l) && CRASH_RE.test(l.replace(QUOTED_RE, '""')));
}

const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';

function bareBlock(text, names) {
  const t = text.trimStart();
  const banner = BANNER_RE.exec(t);
  if (banner) {
    const head = banner[1];
    const first = head.split(/[ -]/)[0];
    if (!GENERIC_FIRST.has(first) && !GENERIC_TAIL_RE.test(head)) return { hook: head, reason: text };
  }
  const name = HOOK_NAME_RE.exec(t);
  if (name && names.has(name[1])) return { hook: name[1], reason: text };
  return null;
}

function prefixedBlock(text) {
  const p = PREFIXED_RE.exec(text);
  if (p) {
    let rest = text.slice(p[0].length);
    const br = /^\[([^\]]*)\]:?\s*/.exec(rest);
    if (br) rest = rest.slice(br[0].length);
    return { hookEvent: p[1], hook: (br && scriptName(br[1])) || `${p[1]}${p[2] || ''}`, reason: rest.trim() };
  }
  const m = BRACKET_RE.exec(text);
  if (m) {
    const evName = text.split(/[:\s]/)[0];
    return {
      hookEvent: new RegExp(`^(?:${EVENTS})$`).test(evName) ? evName : 'PreToolUse',
      hook: scriptName(m[1]) || firstLine(text).slice(0, 30),
      reason: text.slice(m[0].length).trim(),
    };
  }
  return null;
}

async function* normalize(file, { sinceMs = 0, untilMs = Infinity, kind = 'main', hookNames: names = new Set() } = {}) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  const seenUses = new Set();
  const blocked = new Set();
  const edits = new Map();
  let calls = 0;
  let lastTs = null;
  let n = 0;

  const midEdit = (a) => {
    const stderr = String(a.stderr || '');
    if (!/SyntaxError/.test(stderr)) return false;
    for (const [base, e] of edits) {
      if (!stderr.includes(base)) continue;
      const at = e.id === a.toolUseID ? e.prevAt : e.at;
      if (at != null && calls - at <= MID_EDIT_CALLS) return true;
    }
    return false;
  };

  for await (const line of rl) {
    n += 1;
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;
    if (ev.timestamp) lastTs = ev.timestamp;
    if (lastTs === null) continue;
    const ms = Date.parse(lastTs);
    if (!(ms >= sinceMs && ms < untilMs)) continue;

    const base = { session: ev.sessionId || ev.session_id, line: n, ts: lastTs };

    if (ev.type === 'assistant') {
      const said = blocksOf(ev).filter((b) => b.type === 'text').map((b) => b.text || '').join('\n').trim();
      if (said) yield { kind: 'assistant_text', ...base, text: said, agent: kind, meta: isMeta(ev) };
      for (const b of blocksOf(ev).filter((x) => x.type === 'tool_use')) {
        if (seenUses.has(b.id)) continue;
        seenUses.add(b.id);
        calls += 1;
        const target = EDIT_TOOLS.has(b.name) && b.input && b.input.file_path;
        if (target) {
          const key = path.basename(String(target));
          const prev = edits.get(key);
          edits.set(key, { id: b.id, at: calls, prevAt: prev ? prev.at : null });
        }
        yield {
          kind: 'tool_use', ...base, id: b.id, name: b.name, input: b.input,
          messageId: (ev.message && ev.message.id) || null,
          inputHash: crypto.createHash('sha1').update(b.name + stableStringify(b.input || {})).digest('hex'),
          agent: kind,
        };
      }
    } else if (ev.type === 'user') {
      for (const r of blocksOf(ev).filter((b) => b.type === 'tool_result')) {
        const text = resultText(r);
        const id = r.tool_use_id || null;
        if (r.is_error) {
          if (id && blocked.has(id)) continue;
          const found = prefixedBlock(text) || (() => {
            const bare = bareBlock(text, names);
            return bare && { hookEvent: 'PreToolUse', ...bare };
          })();
          if (found) {
            if (id) blocked.add(id);
            yield { kind: 'block', ...base, toolUseId: id, hookEvent: found.hookEvent, hook: found.hook, reason: found.reason };
            continue;
          }
        }
        yield { kind: 'tool_result', ...base, toolUseId: id, isError: !!r.is_error, text };
      }
      const said = blocksOf(ev).filter((b) => b.type === 'text').map((b) => b.text || '').join('\n')
        .replace(REMINDER_RE, '').trim();
      if (said) yield { kind: 'user_text', ...base, text: said, agent: kind, meta: isMeta(ev) };
    } else if (ev.type === 'attachment') {
      const a = ev.attachment || {};
      const hookName = a.hookName || '';
      const hook = scriptName(a.command) || hookName || '?';
      const hookEvent = hookName.split(':')[0] || a.hookEvent || '';
      // The exposure denominator of hook-error: every run of a hook, failing or not.
      if (RAN_TYPES.has(a.type)) yield { kind: 'hook_run', ...base, hookEvent, hook };
      if (a.type === 'hook_blocking_error') {
        const id = a.toolUseID || null;
        if (id && blocked.has(id)) continue;
        if (id) blocked.add(id);
        const reason = (a.blockingError && a.blockingError.blockingError) || a.content || '';
        yield { kind: 'block', ...base, toolUseId: id, hookEvent, hook, reason };
      } else if (a.type === 'hook_non_blocking_error' && !midEdit(a)) {
        yield { kind: 'hook_error', ...base, hookEvent, hook, type: 'non_blocking', detail: firstLine(a.stderr) || `exit ${a.exitCode}` };
      } else if (a.type === 'hook_cancelled' && a.timedOut && !(a.durationMs > (a.timeoutMs || Infinity) * SLEEP_FACTOR)) {
        yield { kind: 'hook_error', ...base, hookEvent, hook, type: 'timeout', detail: `timed out after ${a.timeoutMs}ms` };
      } else if (a.type === 'hook_success' && crashed(a.stderr) && !midEdit(a)) {
        yield { kind: 'hook_error', ...base, hookEvent, hook, type: 'crash', detail: firstLine(String(a.stderr).trim()).slice(0, 200) };
      }
    }
  }
}

module.exports = { listTranscripts, normalize, hookNames };
