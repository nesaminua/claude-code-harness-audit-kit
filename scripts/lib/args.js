'use strict';

const paths = require('./paths');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const USAGE = 'usage: audit.js [--since-last | --days N | --date YYYY-MM-DD] [--json] [--projects-dir DIR]';
const usageError = (message) => Object.assign(new Error(message), { usage: true });

const toDate = (day) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d); };

function parseArgs(argv, today) {
  const args = { mode: 'since-last', json: false, projectsDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--since-last') args.mode = 'since-last';
    else if (a === '--days') { args.mode = 'days'; args.days = Number(argv[++i]); }
    else if (a === '--date') { args.mode = 'date'; args.date = argv[++i]; }
    else if (a === '--projects-dir') args.projectsDir = argv[++i];
    else throw usageError(`unknown argument: ${a}`);
  }
  if (args.mode === 'days' && !(Number.isInteger(args.days) && args.days > 0)) throw usageError('--days needs a positive integer');
  if (args.mode === 'date' && !isRealDay(args.date)) throw usageError('--date needs a real day as YYYY-MM-DD');
  // A run on today or a later day would move audited_through past days never audited.
  if (args.mode === 'date' && args.date >= today) throw usageError('--date must be a day before today');
  return args;
}

// DAY_RE alone accepts 2026-13-45, which Date rolls over to a different, valid day.
function isRealDay(text) {
  return DAY_RE.test(text || '') && paths.localDay(toDate(text)) === text;
}

module.exports = { parseArgs, isRealDay, toDate, USAGE };
