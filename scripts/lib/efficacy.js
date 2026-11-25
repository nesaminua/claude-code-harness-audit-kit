'use strict';

const WINDOW_DAYS = 7;
const MIN_AFTER_DAYS = 3;
const MIN_HITS = 3;
const MIN_EXPOSED = 3;
const VERDICTS = ['effective', 'reduced', 'ineffective', 'insufficient', 'pending'];
// Derived from the trend of all sessions, so they have no session denominator of their own.
const AUDIT_LEVEL_RULES = new Set(['claude-version-changed', 'outcome-regression', 'outcome-shift']);
const TREND_REASON = 'measured by the trend itself';

function sumWindow(days, reportsByDay, key) {
  let hits = 0;
  let exposed = 0;
  for (const d of days) {
    const entry = (reportsByDay[d] || {})[key] || {};
    hits += entry.hitSessions || 0;
    exposed += entry.exposedSessions || 0;
  }
  return { days: days.length, hits, exposed, rate: exposed ? hits / exposed : 0 };
}

function verdictOf(before, after) {
  if (after.days < MIN_AFTER_DAYS) return 'pending';
  if ((before.hits < MIN_HITS && after.hits < MIN_HITS) || after.exposed < MIN_EXPOSED) return 'insufficient';
  if (after.hits === 0) return 'effective';
  if (after.rate <= 0.5 * before.rate) return 'reduced';
  return 'ineffective';
}

function evaluate(ledgerRows, reportsByDay) {
  const audited = Object.keys(reportsByDay || {}).sort();
  const results = ledgerRows.map((row) => {
    const nextFix = ledgerRows
      .filter((o) => o.key === row.key && o.date > row.date)
      .map((o) => o.date)
      .sort()[0];
    const beforeDays = audited.filter((d) => d < row.date).slice(-WINDOW_DAYS);
    const afterDays = audited
      .filter((d) => d > row.date && (nextFix === undefined || d < nextFix))
      .slice(0, WINDOW_DAYS);
    const before = sumWindow(beforeDays, reportsByDay || {}, row.key);
    const after = sumWindow(afterDays, reportsByDay || {}, row.key);
    const base = { key: row.key, rule: row.rule, date: row.date, note: row.note, before, after };
    if (AUDIT_LEVEL_RULES.has(row.rule)) return { ...base, verdict: 'n/a', reason: TREND_REASON };
    return { ...base, verdict: verdictOf(before, after) };
  });
  return results.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function summary(results) {
  const out = { tracked: results.length };
  for (const v of VERDICTS) out[v] = results.filter((r) => r.verdict === v).length;
  out.na = results.filter((r) => r.verdict === 'n/a').length;
  return out;
}

module.exports = { evaluate, summary, AUDIT_LEVEL_RULES };
