'use strict';

const { shortHook, finding, addExposure } = require('./util');

const id = 'hook-slow';
const title = 'Hook runs slowly enough to be felt on every tool call';
const severity = 'medium';
// A hang is killed near its timeout; a run this far past it means the machine slept.
const SLEEP_FACTOR = 10;
// Every hook of a session slowing at once is the machine (load, low-power mode), not one script.
const SLOW_SAMPLE_MS = 5000;
const BURST_WINDOW_MS = 2000;
const BURST_MIN_OTHERS = 3;

// Nearest rank: at 20 runs the 19th value, so a single slow run never decides the p95.
const p95Of = (sorted) => sorted[Math.ceil((sorted.length * 95) / 100) - 1];

function burstRuns(runs) {
  const slow = runs.filter((r) => r.ms >= SLOW_SAMPLE_MS && Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
  const contended = new Set();
  slow.forEach((r, i) => {
    const others = new Set();
    for (let j = i - 1; j >= 0 && r.t - slow[j].t <= BURST_WINDOW_MS; j -= 1) others.add(slow[j].hook);
    for (let j = i + 1; j < slow.length && slow[j].t - r.t <= BURST_WINDOW_MS; j += 1) others.add(slow[j].hook);
    others.delete(r.hook);
    if (others.size >= BURST_MIN_OTHERS) contended.add(r);
  });
  return contended;
}

function create(config, deps) {
  const detector = { id, severity };
  const slowMs = config?.thresholds?.hookSlowMs ?? 5000;
  const maxMs = config?.thresholds?.hookSlowMaxMs ?? null;
  // Below ~20 runs p95 is the maximum itself, i.e. one slow run.
  const minRuns = config?.thresholds?.hookSlowMinRuns ?? 20;
  const runsBySession = new Map();
  const exposedSessions = new Set();
  const exposureByKey = new Map();

  function onEvent(ev) {
    if (ev.kind !== 'hook_run') return;
    const hook = shortHook(ev.hook);
    exposedSessions.add(ev.session);
    addExposure(exposureByKey, `${id}:${hook}`, ev.session);
    // A cancelled run is hook-error's timeout.
    if (ev.outcome === 'cancelled' || typeof ev.durationMs !== 'number') return;
    if (ev.timeoutMs && ev.durationMs > ev.timeoutMs * SLEEP_FACTOR) return;
    const list = runsBySession.get(ev.session) || [];
    list.push({ hook, ms: ev.durationMs, t: Date.parse(ev.ts), ev });
    runsBySession.set(ev.session, list);
  }

  function judge(runs) {
    const sorted = runs.map((r) => r.ms).sort((a, b) => a - b);
    const p95 = p95Of(sorted);
    const max = sorted[sorted.length - 1];
    const tail = sorted.length >= minRuns && p95 >= slowMs;
    if (!tail && !(maxMs !== null && max >= maxMs)) return null;
    return { severity: tail ? 'medium' : 'low', summary: `${runs[0].hook}: ${sorted.length} run(s), p95 ${p95} ms, max ${max} ms` };
  }

  function finish() {
    const findings = [];
    for (const runs of runsBySession.values()) {
      const burst = burstRuns(runs);
      const byHook = new Map();
      for (const r of runs.filter((x) => !burst.has(x))) byHook.set(r.hook, [...(byHook.get(r.hook) || []), r]);
      for (const [hook, list] of byHook) {
        const verdict = judge(list);
        if (!verdict) continue;
        const worst = list.reduce((a, b) => (b.ms > a.ms ? b : a));
        findings.push(finding(detector, worst.ev, { key: `${id}:${hook}`, hook, ...verdict, evidence: [] }, deps));
      }
    }
    return { findings, exposedSessions, exposureByKey };
  }

  return { onEvent, finish };
}

module.exports = { id, title, severity, create };
