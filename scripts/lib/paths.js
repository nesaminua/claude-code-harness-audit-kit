'use strict';

const os = require('os');
const path = require('path');

function claudeDir() {
  return process.env.HARNESS_AUDIT_CLAUDE_DIR
    || process.env.CLAUDE_CONFIG_DIR
    || path.join(os.homedir(), '.claude');
}

function kitDir() {
  return process.env.HARNESS_AUDIT_KIT_HOME || path.join(claudeDir(), 'harness-audit-kit');
}

const dataDir = () => path.join(kitDir(), 'data');
const reportsDir = () => path.join(dataDir(), 'reports');
const queueFile = () => path.join(dataDir(), 'queue.json');
const ledgerFile = () => path.join(dataDir(), 'fix-ledger.json');
const stateFile = () => path.join(dataDir(), 'state.json');
const configFile = () => path.join(kitDir(), 'config.json');
const settingsFile = () => path.join(claudeDir(), 'settings.json');
const rulesDir = () => path.join(claudeDir(), 'rules');

function projectsDir(config) {
  return (config && config.projectsDir) || path.join(claudeDir(), 'projects');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function localDay(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

module.exports = {
  claudeDir, kitDir, dataDir, reportsDir, queueFile, ledgerFile, stateFile, configFile,
  settingsFile, rulesDir, projectsDir, localDay,
};
