#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./lib/paths.js');
const queue = require('./lib/queue.js');
const { redact } = require('./lib/redact.js');
const { formatLine, flat, safeOut, makeNote } = require('./fix.js');

const VERDICTS = ['effective', 'reduced', 'ineffective', 'insufficient', 'pending'];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function section(out, file, fn) {
  try {
    fn();
  } catch (err) {
    out.write(`(${file} unreadable: ${flat(redact(err.message))})\n`);
  }
}

function header(out) {
  const config = paths.configFile();
  out.write(`claude dir: ${redact(paths.claudeDir())}\n`);
  out.write(`kit dir: ${redact(paths.kitDir())}\n`);
  out.write(`config: ${redact(config)} (${fs.existsSync(config) ? 'exists' : 'missing'})\n`);
  section(out, 'state.json', () => {
    const state = readJson(paths.stateFile(), {});
    out.write(`last audit: ${state.last_run || 'never'}\n`);
    out.write(`audited through: ${state.audited_through || '--'}\n`);
  });
  if (!fs.existsSync(paths.kitDir())) out.write('Kit is not installed. Run: node install.js\n');
}

function openItems(out, note) {
  section(out, 'queue.json', () => {
    const items = queue.ordered(queue.load());
    out.write(`\nopen items: ${items.length}\n`);
    if (items.length) note();
    for (const item of items.slice(0, 10)) out.write(`${formatLine(item)}\n`);
  });
}

const cell = (side) => `${side.hits} hits / ${side.exposed} exposed`;

function efficacy(out, note) {
  out.write('\n');
  section(out, 'efficacy.json', () => {
    const data = readJson(path.join(paths.dataDir(), 'efficacy.json'), null);
    const rows = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
    if (rows.length === 0) {
      out.write('No fixes measured yet.\n');
      return;
    }
    note();
    out.write('key | fixed on | before | after | verdict\n');
    for (const r of rows) out.write(`${flat(r.key)} | ${flat(r.date)} | ${cell(r.before)} | ${cell(r.after)} | ${flat(r.verdict)}\n`);
    const counts = VERDICTS.map((v) => `${v} ${rows.filter((r) => r.verdict === v).length}`);
    out.write(`fixes ${rows.length}: ${counts.join(', ')}\n`);
  });
}

function main(argv, { out: rawOut = process.stdout } = {}) {
  const out = safeOut(rawOut);
  const note = makeNote(out);
  header(out);
  openItems(out, note);
  efficacy(out, note);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };
