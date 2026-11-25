#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./lib/paths');
const { loadConfig } = require('./lib/config');
const { listTranscripts, normalize, hookNames } = require('./lib/transcript');
const { enabledDetectors } = require('./lib/detectors');
const { redactKey } = require('./lib/detectors/util');
const { parseArgs, toDate, USAGE } = require('./lib/args');
const queueLib = require('./lib/queue');
const efficacy = require('./lib/efficacy');
const report = require('./lib/report');

const MAX_CATCHUP_DAYS = 7;

const addDays = (day, n) => { const d = toDate(day); d.setDate(d.getDate() + n); return paths.localDay(d); };
const dayRange = (from, to) => {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

function resolveDays(args, state, today) {
  const yesterday = addDays(today, -1);
  if (args.mode === 'date') return [args.date];
  if (args.mode === 'days') return dayRange(addDays(today, -args.days), yesterday);
  if (!state.audited_through) return [yesterday];
  const start = [addDays(state.audited_through, 1), addDays(today, -MAX_CATCHUP_DAYS)].sort().pop();
  return dayRange(start, yesterday);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function settingsHookNames() {
  try { return hookNames(fs.readFileSync(paths.settingsFile(), 'utf8')); } catch { return new Set(); }
}

// finding() redacts the part of a key after the first colon; exposure must land on the same key.
const exposureKey = (key) => redactKey(key);

function addTo(map, key, value) {
  const set = map.get(key) || new Set();
  set.add(value);
  map.set(key, set);
}

async function scanFile(file, ctx) {
  const instances = enabledDetectors(ctx.config).map((d) => d.create(ctx.config));
  const fileDays = new Set();
  for await (const ev of normalize(file.file, { sinceMs: ctx.sinceMs, untilMs: ctx.untilMs, kind: file.kind, hookNames: ctx.names })) {
    const day = paths.localDay(ev.ts);
    if (ev.session && day) addTo(ctx.touched, ev.session.slice(0, 8), day);
    if (day) fileDays.add(day);
    if (day && ev.session && ev.kind === 'tool_use') addTo(ctx.toolSessions, `${exposureKey(`tool-error-loop:${ev.name}`)}\u0000${day}`, ev.session.slice(0, 8));
    for (const inst of instances) inst.onEvent(ev);
  }
  for (const day of fileDays) ctx.transcriptsByDay.set(day, (ctx.transcriptsByDay.get(day) || 0) + 1);
  for (const inst of instances) {
    const res = inst.finish();
    ctx.findings.push(...res.findings);
    (res.warnings || []).forEach((w) => ctx.warnings.add(w));
    for (const [key, sessions] of res.exposureByKey) {
      for (const s of sessions) addTo(ctx.exposure, exposureKey(key), String(s).slice(0, 8));
    }
  }
}

const HOOK_RULES = new Set(['block-loop', 'block-bypassed', 'retry-verbatim', 'hook-error']);
const touchedOn =(ctx, day) => [...ctx.touched.values()].filter((d) => d.has(day)).length;

function exposedOn(key, day, ctx) {
  // Every session that day could have been corrected by the user, whether or not one was.
  if (key.startsWith('user-correction:')) return touchedOn(ctx, day);
  const colon = key.indexOf(':');
  const rule = key.slice(0, colon);
  // An installed hook is exposed to every session, so a fix that silences it cannot shrink its own denominator.
  if (HOOK_RULES.has(rule) && ctx.names.has(key.slice(colon + 1))) return touchedOn(ctx, day);
  if (rule === 'tool-error-loop') return (ctx.toolSessions.get(`${key}\u0000${day}`) || new Set()).size;
  return [...(ctx.exposure.get(key) || [])].filter((s) => (ctx.touched.get(s) || new Set()).has(day)).length;
}

function buildDaily(days, ctx) {
  const lastDay = days[days.length - 1];
  const byDay = new Map(days.map((d) => [d, []]));
  for (const f of ctx.findings) {
    const day = paths.localDay(f.ts);
    byDay.get(byDay.has(day) ? day : lastDay).push(f);
  }
  const daily = {};
  for (const day of days) {
    const rows = {};
    for (const f of byDay.get(day)) {
      rows[f.key] = rows[f.key] || { hits: new Set() };
      rows[f.key].hits.add(f.session);
    }
    const keys = new Set([...Object.keys(rows), ...ctx.exposure.keys(), ...ctx.ledgerKeys]);
    daily[day] = {};
    for (const key of keys) {
      const exposed = exposedOn(key, day, ctx);
      const hitSessions = rows[key] ? rows[key].hits.size : 0;
      if (hitSessions || exposed || ctx.ledgerKeys.has(key)) daily[day][key] = { hitSessions, exposedSessions: exposed };
    }
  }
  return { byDay, daily };
}

function isIgnored(project, config) {
  return (config.ignoreProjects || []).some((p) => p && project.includes(p));
}

// Only a JSON syntax error moves the queue aside; a read error (EACCES, EBUSY, EISDIR) aborts and leaves it.
function loadQueueSafely(warnings) {
  const file = paths.queueFile();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return queueLib.load();
    throw err;
  }
  try {
    JSON.parse(raw);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    const moved = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, moved);
    warnings.add(`queue.json was unreadable and moved to ${path.basename(moved)}; the queue starts empty`);
  }
  return queueLib.load();
}

async function main(argv = process.argv.slice(2), { out = console.log } = {}) {
  const now = new Date();
  const today = paths.localDay(now);
  const args = parseArgs(argv, today);
  const { config, warnings: configWarnings } = loadConfig();
  const state = readJson(paths.stateFile(), {});
  const ledgerRows = readJson(paths.ledgerFile(), []);
  const days = resolveDays(args, state, today);
  const result = { days, findings: 0, transcripts: 0, open: 0 };
  if (!days.length) {
    out(args.json ? JSON.stringify(result) : 'harness audit: nothing new to audit');
    return result;
  }

  const ctx = {
    config, names: settingsHookNames(), findings: [], warnings: new Set(configWarnings),
    touched: new Map(), exposure: new Map(), transcriptsByDay: new Map(), toolSessions: new Map(),
    ledgerKeys: new Set((Array.isArray(ledgerRows) ? ledgerRows : []).map((r) => r && r.key).filter(Boolean)),
    sinceMs: toDate(days[0]).getTime(), untilMs: toDate(addDays(days[days.length - 1], 1)).getTime(),
  };
  const projectsDir = paths.projectsDir({ ...config, projectsDir: args.projectsDir || config.projectsDir });
  const files = listTranscripts({ projectsDir, sinceMs: ctx.sinceMs }).filter((f) => !isIgnored(f.project, config));
  for (const file of files) await scanFile(file, ctx);

  const { byDay, daily } = buildDaily(days, ctx);
  const queue = loadQueueSafely(ctx.warnings);
  queueLib.upsert(queue, ctx.findings);
  queueLib.expire(queue, today, config.queue.expireDays);
  queueLib.save(queue);
  const open = queueLib.ordered(queue);

  for (const day of days) {
    const rep = report.buildReport({
      date: day, window: { since: day, until: day }, findings: byDay.get(day), daily: { [day]: daily[day] },
      warnings: [...ctx.warnings], stats: { transcripts: ctx.transcriptsByDay.get(day) || 0 },
    });
    report.writeReport(rep, report.renderMarkdown(rep, { open }), { hadTranscripts: (ctx.transcriptsByDay.get(day) || 0) > 0 });
  }

  const results = efficacy.evaluate(Array.isArray(ledgerRows) ? ledgerRows : [], report.loadDailyReports());
  writeJson(path.join(paths.dataDir(), 'efficacy.json'), { generated_at: now.toISOString(), summary: efficacy.summary(results), results });

  const last = days[days.length - 1];
  // Re-read: the session hook may have written the state while this run scanned.
  const fresh = readJson(paths.stateFile(), {});
  writeJson(paths.stateFile(), { ...fresh, audited_through: [fresh.audited_through || '', last].sort().pop(), last_run: now.toISOString() });
  report.pruneReports(config.retentionDays, today, { keep: days });

  Object.assign(result, { findings: ctx.findings.length, transcripts: files.length, open: open.length });
  out(args.json ? JSON.stringify(result)
    : `harness audit ${days[0]}..${last}: ${result.findings} findings, ${result.transcripts} transcripts, ${result.open} open items`);
  return result;
}

module.exports = { main };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`harness audit failed: ${err.message}\n`);
    if (err.usage) process.stderr.write(`${USAGE}\n`);
    process.exit(1);
  });
}
