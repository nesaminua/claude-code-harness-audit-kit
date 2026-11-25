'use strict';

const paths = require('./paths');

const WINDOW_DAYS = 7;
const RETRY_WINDOW = 3;
const MIN_EVENTS = 3;
const SHIFT_PCT = 50;
const DEFAULT_MIN_SESSIONS = 10;
const DEFAULT_MIN_DAYS = 7;
const MAX_SEEN_VERSIONS = 20;
const DEFAULT_REGRESSION_PCT = 30;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]{0,20})?$/;
const COUNTS = ['tool_calls', 'blocks', 'retries', 'tool_errors', 'corrections', 'interrupts'];
const RAW_KEYS = ['sessions', ...COUNTS];

// worse: a rise is a regression. The neutral metric only reports a shift.
const METRICS = [
  { id: 'tool_calls_per_session', label: 'tool calls per session', num: 'tool_calls', den: 'sessions', scale: 1, worse: false },
  { id: 'blocks_per_100_calls', label: 'blocks per 100 tool calls', num: 'blocks', den: 'tool_calls', scale: 100, worse: true },
  { id: 'retry_after_block_rate', label: 'retry-after-block rate', num: 'retries', den: 'blocks', scale: 1, worse: true },
  { id: 'tool_errors_per_session', label: 'tool errors per session', num: 'tool_errors', den: 'sessions', scale: 1, worse: true },
  { id: 'corrections_per_session', label: 'user corrections per session', num: 'corrections', den: 'sessions', scale: 1, worse: true },
  { id: 'interrupts_per_session', label: 'user interrupts per session', num: 'interrupts', den: 'sessions', scale: 1, worse: true },
];

const round2 = (x) => Math.round(x * 100) / 100;
const rateOf = (raw, m) => (raw[m.den] > 0 ? round2((m.scale * raw[m.num]) / raw[m.den]) : 0);

function derive(raw) {
  return { ...raw, ...Object.fromEntries(METRICS.map((m) => [m.id, rateOf(raw, m)])) };
}

const emptyDay = () => ({ sessions: new Set(), ...Object.fromEntries(COUNTS.map((k) => [k, 0])) });

function retryTracker() {
  const useKey = new Map();
  const pending = new Map();
  return {
    use(ev, row) {
      if (ev.id) useKey.set(ev.id, ev.inputHash);
      const p = pending.get(ev.session);
      if (!p) return;
      if (ev.inputHash === p.key) {
        row.retries += 1;
        pending.delete(ev.session);
      } else if (p.left > 1) {
        pending.set(ev.session, { ...p, left: p.left - 1 });
      } else {
        pending.delete(ev.session);
      }
    },
    block(ev) {
      const key = useKey.get(ev.toolUseId);
      if (key) pending.set(ev.session, { key, left: RETRY_WINDOW });
    },
  };
}

function versionTracker() {
  let latest = null;
  return {
    see(ev) {
      const ms = Date.parse(ev.ts);
      const valid = typeof ev.version === 'string' && VERSION_RE.test(ev.version) && !Number.isNaN(ms);
      if (valid && (!latest || ms > latest.ms)) latest = { version: ev.version, ts: ev.ts, ms };
    },
    latest: () => (latest ? { version: latest.version, ts: latest.ts } : null),
  };
}

const FINDING_FIELD = { 'user-correction': 'corrections', 'user-interrupt': 'interrupts' };

function collector() {
  const days = new Map();
  const retries = retryTracker();
  const versions = versionTracker();
  const rowFor = (ts) => {
    const day = paths.localDay(ts);
    if (!day) return null;
    if (!days.has(day)) days.set(day, emptyDay());
    return days.get(day);
  };
  const handlers = {
    tool_use(row, ev) { row.tool_calls += 1; retries.use(ev, row); },
    block(row, ev) { row.blocks += 1; retries.block(ev); },
    tool_result(row, ev) { if (ev.isError) row.tool_errors += 1; },
  };
  return {
    onEvent(ev) {
      const row = rowFor(ev.ts);
      if (!row) return;
      if (ev.session) row.sessions.add(ev.session);
      versions.see(ev);
      if (handlers[ev.kind]) handlers[ev.kind](row, ev);
    },
    addFindings(findings) {
      for (const f of findings) {
        const field = FINDING_FIELD[f.rule];
        const row = field && rowFor(f.ts);
        if (row) row[field] += 1;
      }
    },
    metrics: () => Object.fromEntries([...days].map(([day, row]) => [day, derive({ ...row, sessions: row.sessions.size })])),
    latestVersion: () => versions.latest(),
  };
}

const isDay = (v) => v && typeof v === 'object' && v.sessions > 0 && COUNTS.every((k) => typeof v[k] === 'number');

function sumWindow(entries) {
  const raw = Object.fromEntries(RAW_KEYS.map((k) => [k, entries.reduce((t, [, v]) => t + v[k], 0)]));
  return {
    days: entries.length, from: entries[0][0], to: entries[entries.length - 1][0],
    sessions: raw.sessions, raw, rates: Object.fromEntries(METRICS.map((m) => [m.id, rateOf(raw, m)])),
  };
}

function auditedEntries(metricsByDay, today) {
  return Object.entries(metricsByDay || {})
    .filter(([day, v]) => (!today || day < today) && isDay(v))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

const auditedDays = (metricsByDay, { today } = {}) => auditedEntries(metricsByDay, today).length;

function compare(metricsByDay, { today, size = WINDOW_DAYS } = {}) {
  const audited = auditedEntries(metricsByDay, today).slice(-2 * size);
  const split = audited.length - size;
  if (split < 1) return null;
  return { before: sumWindow(audited.slice(0, split)), after: sumWindow(audited.slice(split)) };
}

// The one place that sizes the trend windows: minDays audited days each side, never more than a week.
function trendWindow(metricsByDay, { today, config } = {}) {
  const wanted = config?.outcome?.minDays;
  const size = Number.isInteger(wanted) && wanted >= 1 ? Math.min(wanted, WINDOW_DAYS) : DEFAULT_MIN_DAYS;
  const cmp = compare(metricsByDay, { today, size });
  const ready = Boolean(cmp) && cmp.before.days >= size && cmp.after.days >= size;
  return { size, needs: 2 * size, have: auditedDays(metricsByDay, { today }), ready, cmp: ready ? cmp : null };
}

const windowText = (w, m) => `${w.from}..${w.to}: ${w.sessions} sessions, ${m.label} ${w.rates[m.id]}`;
const endOfWindow = (d) => new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)), 12).toISOString();

function makeFinding(rule, severity, m, { before, after }) {
  const pct = before.rates[m.id] > 0 ? (after.rates[m.id] / before.rates[m.id] - 1) * 100 : 100;
  return {
    rule, severity, key: `${rule}:${m.id}`, session: 'audit', line: null, ts: endOfWindow(after.to), hook: null,
    summary: `${m.label} ${before.rates[m.id]} → ${after.rates[m.id]} (${pct >= 0 ? '+' : ''}${Math.round(pct)}%) (last ${after.days} days vs previous ${before.days} days)`,
    evidence: [windowText(before, m), windowText(after, m)],
  };
}

// Compared as products of integers, so an exact threshold is not lost to float rounding.
function ratios(m, before, after) {
  if (!(before.raw[m.den] > 0) || !(after.raw[m.den] > 0)) return null;
  const left = after.raw[m.num] * before.raw[m.den] * 100;
  const right = before.raw[m.num] * after.raw[m.den];
  return { grew: (pct) => left >= right * (100 + pct), fell: (pct) => left <= right * (100 - pct), hadBase: right > 0 };
}

function judge(m, cmp, regressionPct) {
  const r = ratios(m, cmp.before, cmp.after);
  if (!r) return null;
  if (m.worse) {
    const real = cmp.after.raw[m.num] >= MIN_EVENTS && r.grew(regressionPct);
    return real ? makeFinding('outcome-regression', 'medium', m, cmp) : null;
  }
  const moved = r.hadBase && (r.grew(SHIFT_PCT) || r.fell(SHIFT_PCT));
  return moved ? makeFinding('outcome-shift', 'low', m, cmp) : null;
}

function trend(metricsByDay, { today, config } = {}) {
  const minSessions = config?.outcome?.minSessions ?? DEFAULT_MIN_SESSIONS;
  const regressionPct = config?.outcome?.regressionPct ?? DEFAULT_REGRESSION_PCT;
  const { cmp } = trendWindow(metricsByDay, { today, config });
  if (!cmp || cmp.before.sessions < minSessions || cmp.after.sessions < minSessions) return [];
  return METRICS.map((m) => judge(m, cmp, regressionPct)).filter(Boolean);
}

// Numeric, so 2.1.10 is newer than 2.1.9; a release is newer than its own prerelease.
// Returns null for anything that is not a version, so a hand-edited state can never throw here.
function compareVersions(a, b) {
  const [pa, pb] = [a, b].map((v) => (typeof v === 'string' ? /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(v) : null));
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff) return Math.sign(diff);
  }
  if (pa[4] === pb[4]) return 0;
  if (!pa[4] || !pb[4]) return pa[4] ? -1 : 1;
  return pa[4] < pb[4] ? -1 : 1;
}

const isVersion = (v) => typeof v === 'string' && VERSION_RE.test(v);
const remember = (seen, version) => [...seen.filter((v) => v !== version), version].slice(-MAX_SEEN_VERSIONS);

function versionChange(state, latest) {
  const none = { finding: null, next: null };
  if (!latest || !isVersion(latest.version)) return none;
  const seenAt = Date.parse(latest.ts);
  if (Number.isNaN(seenAt)) return none;
  const from = isVersion(state?.last_version) ? state.last_version : null;
  const known = [...new Set((Array.isArray(state?.seen_versions) ? state.seen_versions : []).filter(isVersion))];
  const seen = from && !known.includes(from) ? [...known, from] : known;
  const next = { last_version: latest.version, last_version_at: latest.ts, seen_versions: remember(seen, latest.version) };
  if (!from) return { finding: null, next };
  if (seenAt <= Date.parse(state.last_version_at || 0)) return none;
  const order = compareVersions(latest.version, from);
  if (order === null || order < 0) return none;
  if (order === 0 || seen.includes(latest.version)) return { finding: null, next };
  return {
    next,
    finding: {
      rule: 'claude-version-changed', severity: 'low', key: `claude-version-changed:${latest.version}`,
      session: 'audit', line: null, ts: latest.ts, hook: null,
      summary: `CLI version ${from} → ${latest.version}: re-run your hook tests`,
      evidence: [`first seen in a transcript at ${latest.ts}`],
    },
  };
}

module.exports = { collector, trend, trendWindow, compare, auditedDays, versionChange, derive, METRICS, DEFAULT_MIN_DAYS };
