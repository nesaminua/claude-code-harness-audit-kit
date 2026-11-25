'use strict';

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const { redact } = require('./redact');
const { writePrivate } = require('./private-write');

const TOP_ITEMS = 10;
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.(json|md)$/;

const cell = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();

function summarizeRules(findings) {
  const rules = new Map();
  for (const f of findings) {
    const row = rules.get(f.rule) || { rule: f.rule, findings: 0, sessions: new Set() };
    row.findings += 1;
    row.sessions.add(f.session);
    rules.set(f.rule, row);
  }
  return [...rules.values()]
    .map((r) => ({ rule: r.rule, findings: r.findings, sessions: r.sessions.size }))
    .sort((a, b) => b.findings - a.findings || a.rule.localeCompare(b.rule));
}

function buildReport({ date, window, findings = [], daily = {}, metrics = {}, warnings = [], stats = {} }) {
  return {
    date,
    window,
    generated_at: new Date().toISOString(),
    summary: {
      findings: findings.length,
      sessions: new Set(findings.map((f) => f.session)).size,
      transcripts: stats.transcripts || 0,
    },
    rules: summarizeRules(findings),
    findings,
    daily,
    metrics,
    warnings: warnings.map((w) => redact(String(w))),
    stats,
  };
}

function renderMarkdown(report, { open = [] } = {}) {
  const s = report.summary;
  const lines = [
    `# Harness audit ${report.date}`,
    '',
    `Findings: ${s.findings} | Sessions: ${s.sessions} | Transcripts: ${s.transcripts} | Open items: ${open.length}`,
    '',
    '| rule | findings | sessions |',
    '|---|---|---|',
    ...report.rules.map((r) => `| ${cell(r.rule)} | ${r.findings} | ${r.sessions} |`),
    '',
    '## Top open items',
    '',
    '| id | rule | hook | seen days | summary |',
    '|---|---|---|---|---|',
    ...open.slice(0, TOP_ITEMS).map((it) => {
      const hook = (it.examples && it.examples[0] && it.examples[0].hook) || '-';
      return `| ${cell(it.id)} | ${cell(it.rule)} | ${cell(hook)} | ${(it.seen_days || []).length} | ${cell(it.title)} |`;
    }),
  ];
  if (report.warnings.length) lines.push('', '## Warnings', '', ...report.warnings.map((w) => `- ${cell(w)}`));
  return `${lines.join('\n')}\n`;
}

const atomicWrite = writePrivate;

function writeReport(report, md, { hadTranscripts = true } = {}) {
  const dir = paths.reportsDir();
  paths.ensureDir(paths.dataDir());
  paths.ensureDir(dir);
  const json = path.join(dir, `${report.date}.json`);
  const mdFile = path.join(dir, `${report.date}.md`);
  atomicWrite(json, JSON.stringify(report, null, 2));
  atomicWrite(mdFile, md);
  mergeIntoIndex(indexFile, report.daily || {}, hadTranscripts);
  mergeIntoIndex(metricsFile, report.metrics || {}, hadTranscripts);
  return { json, md: mdFile };
}

// Efficacy windows read the daily index and the outcome trend reads the metrics index,
// so a pruned report cannot empty a fix's "before" window or a trend window.
const indexFile = () => path.join(paths.dataDir(), 'daily-index.json');
const metricsFile = () => path.join(paths.dataDir(), 'metrics-index.json');

function readIndex(file = indexFile) {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

// A re-audit after the transcripts were deleted sees nothing and must not erase what an earlier run recorded.
function mergeIntoIndex(file, rows, hadTranscripts) {
  const index = readIndex(file);
  const accepted = Object.fromEntries(Object.entries(rows).filter(([day]) => hadTranscripts || !(day in index)));
  atomicWrite(file(), JSON.stringify({ ...index, ...accepted }, null, 2));
}

function readReports(dir) {
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  return names.flatMap((name) => {
    const file = path.join(dir, name);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const at = data.generated_at || fs.statSync(file).mtime.toISOString();
      return [{ name, at, daily: data.daily || {}, metrics: data.metrics || {} }];
    } catch { return []; }
  });
}

function loadDailyReports() {
  const reports = readReports(paths.reportsDir()).sort((a, b) => a.at.localeCompare(b.at) || a.name.localeCompare(b.name));
  return { ...reports.reduce((merged, r) => ({ ...merged, ...r.daily }), {}), ...readIndex() };
}

function loadMetrics() {
  const reports = readReports(paths.reportsDir()).sort((a, b) => a.at.localeCompare(b.at) || a.name.localeCompare(b.name));
  return { ...reports.reduce((merged, r) => ({ ...merged, ...r.metrics }), {}), ...readIndex(metricsFile) };
}

function pruneReports(retentionDays, today, { keep = [] } = {}) {
  const dir = paths.reportsDir();
  const [y, m, d] = today.split('-').map(Number);
  const cutoff = paths.localDay(new Date(y, m - 1, d - retentionDays));
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    const match = DAY_FILE_RE.exec(name);
    if (match && match[1] < cutoff && !keep.includes(match[1])) {
      fs.unlinkSync(path.join(dir, name));
      removed += 1;
    }
  }
  return removed;
}

module.exports = { buildReport, renderMarkdown, writeReport, loadDailyReports, loadMetrics, pruneReports };
