#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./scripts/lib/paths');
const { readSettings, backupSettings, writeSettings, isOurs } = require('./install');

function withoutOurHook(settings) {
  const groups = settings.hooks && settings.hooks.SessionStart;
  if (!Array.isArray(groups)) return { settings, removed: 0 };
  let removed = 0;
  const next = [];
  for (const group of groups) {
    const hooks = (group.hooks || []).filter((h) => {
      if (isOurs(h)) removed += 1;
      return !isOurs(h);
    });
    if (hooks.length) next.push({ ...group, hooks });
  }
  const { SessionStart, ...otherHooks } = settings.hooks;
  const hooks = next.length ? { ...otherHooks, SessionStart: next } : otherHooks;
  return { settings: { ...settings, hooks }, removed };
}

function removeFromSettings(out) {
  const file = paths.settingsFile();
  const read = readSettings(file);
  if (!read.ok) {
    out(`error: ${file} is not valid settings JSON (${read.error}); nothing changed`);
    return false;
  }
  const { settings, removed } = withoutOurHook(read.data);
  if (removed > 0) {
    out(`settings backup: ${backupSettings(file)}`);
    writeSettings(file, settings);
  }
  out(`removed ${removed} SessionStart entr${removed === 1 ? 'y' : 'ies'} from ${file}`);
  return true;
}

function main(argv = process.argv.slice(2), { out = console.log } = {}) {
  if (!removeFromSettings(out)) return 1;
  const rule = path.join(paths.rulesDir(), 'harness-audit.md');
  fs.rmSync(rule, { force: true });
  out(`removed rule ${rule}`);
  const kit = paths.kitDir();
  if (argv.includes('--purge')) {
    fs.rmSync(kit, { recursive: true, force: true });
    out(`purged ${kit}`);
  } else {
    for (const name of ['hooks', 'scripts']) fs.rmSync(path.join(kit, name), { recursive: true, force: true });
    out(`removed hooks and scripts from ${kit}; config.json and data kept (use --purge to delete them)`);
  }
  return 0;
}

module.exports = { main };

if (require.main === module) process.exitCode = main();
