#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./scripts/lib/paths');

const MARKER = 'harness-audit-start.js';
const COPIED = ['hooks', 'scripts', 'config.example.json'];

const pad = (n) => String(n).padStart(2, '0');

function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function hookCommand(kitDir, platform = process.platform) {
  const file = path.join(kitDir, 'hooks', MARKER);
  return `node "${platform === 'win32' ? file.replace(/\\/g, '/') : file}"`;
}

// null data = settings.json missing; ok:false = not a JSON object, caller must leave the file alone.
function readSettings(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, existed: false, data: {} };
    return { ok: false, error: err.message };
  }
  if (!raw.trim()) return { ok: true, existed: true, data: {} };
  try {
    const data = JSON.parse(raw);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'top level must be a JSON object' };
    const error = shapeError(data);
    return error ? { ok: false, error } : { ok: true, existed: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// COPYFILE_EXCL plus a counter: a second run in the same millisecond never replaces an earlier backup.
function backupSettings(file) {
  const base = `${file}.bak-${stamp()}-${String(new Date().getMilliseconds()).padStart(3, '0')}`;
  for (let n = 0; ; n += 1) {
    const backup = n === 0 ? base : `${base}-${n}`;
    try {
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
      return backup;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

// Rename onto the resolved path, so a dotfiles symlink keeps pointing at its target.
function writeSettings(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, target);
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function shapeError(data) {
  if (data.hooks === undefined) return null;
  if (!isObject(data.hooks)) return '"hooks" must be an object';
  const groups = data.hooks.SessionStart;
  if (groups === undefined) return null;
  if (!Array.isArray(groups)) return '"hooks.SessionStart" must be an array';
  const bad = groups.some((g) => !isObject(g) || (g.hooks !== undefined && !Array.isArray(g.hooks)));
  return bad ? 'every "hooks.SessionStart" group must be an object with a "hooks" array' : null;
}

const isOurs = (hook) => typeof (hook && hook.command) === 'string' && hook.command.includes(MARKER);

function withOurHook(settings, command) {
  const entry = { type: 'command', command, timeout: 10 };
  const groups = (settings.hooks && settings.hooks.SessionStart) || [];
  let placed = false;
  const next = [];
  for (const group of groups) {
    const hooks = [];
    for (const hook of group.hooks || []) {
      if (!isOurs(hook)) hooks.push(hook);
      else if (!placed) {
        hooks.push(entry);
        placed = true;
      }
    }
    if (hooks.length) next.push({ ...group, hooks });
  }
  if (!placed) next.push({ hooks: [entry] });
  return { ...settings, hooks: { ...settings.hooks, SessionStart: next } };
}

function copyKit(repoDir, kit) {
  fs.mkdirSync(kit, { recursive: true });
  if (path.resolve(repoDir) === path.resolve(kit)) return;
  for (const name of COPIED) {
    const from = path.join(repoDir, name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(kit, name), { recursive: true, force: true });
  }
}

function installRule(repoDir, out) {
  const from = path.join(repoDir, 'rules', 'harness-audit.md');
  const to = path.join(paths.rulesDir(), 'harness-audit.md');
  if (!fs.existsSync(from)) {
    out('warn: rules/harness-audit.md is missing in the repo, rule not installed');
    return null;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return to;
}

function ensureConfig(kit) {
  const target = paths.configFile();
  const example = path.join(kit, 'config.example.json');
  if (fs.existsSync(target) || !fs.existsSync(example)) return fs.existsSync(target) ? 'kept' : 'missing example';
  fs.copyFileSync(example, target);
  return 'created';
}

function dryRun(plan, out) {
  out('dry run, nothing written');
  out(`would copy ${COPIED.join(', ')} to ${plan.kit}`);
  out(`would install rule ${path.join(paths.rulesDir(), 'harness-audit.md')}`);
  out(`would create config ${paths.configFile()} if missing`);
  out(`would add SessionStart hook to ${plan.settingsFile}: ${plan.command}`);
  if (plan.existed) out('would back up settings.json first');
}

function main(argv = process.argv.slice(2), { out = console.log, repoDir = __dirname, nodeMajor = Number(process.versions.node.split('.')[0]) } = {}) {
  if (nodeMajor < 18) {
    out(`error: Node 18 or newer is required, found ${nodeMajor}`);
    return 1;
  }
  const settingsFile = paths.settingsFile();
  const read = readSettings(settingsFile);
  if (!read.ok) {
    out(`error: ${settingsFile} is not valid settings JSON (${read.error}); left untouched`);
    return 1;
  }
  const kit = paths.kitDir();
  const command = hookCommand(kit);
  if (argv.includes('--dry-run')) {
    dryRun({ kit, settingsFile, command, existed: read.existed }, out);
    return 0;
  }
  copyKit(repoDir, kit);
  const rule = installRule(repoDir, out);
  const config = ensureConfig(kit);
  const backup = read.existed ? backupSettings(settingsFile) : null;
  writeSettings(settingsFile, withOurHook(read.data, command));
  out(`kit dir:  ${kit}`);
  out(`rule:     ${rule || 'not installed'}`);
  out(`settings: ${settingsFile}`);
  out(`backup:   ${backup || 'none (settings.json did not exist)'}`);
  out(`config:   ${config}`);
  out('next: restart Claude Code; the first audit runs at the next session start');
  out(`status: node ${path.join(kit, 'scripts', 'status.js')}`);
  return 0;
}

module.exports = { main, readSettings, backupSettings, writeSettings, isOurs, hookCommand, MARKER };

if (require.main === module) process.exitCode = main();
