'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const paths = require('./paths.js');

const WEIGHT = { high: 3, medium: 2, low: 1 };
const MAX_EXAMPLES = 3;
const DAY_MS = 86400000;

const emptyQueue = () => ({ version: 1, open: [], resolved: [], expired: [], dismissed: [] });
const idOf = (key) => crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);

function load(file = paths.queueFile()) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyQueue();
    throw err;
  }
  try {
    return { ...emptyQueue(), ...JSON.parse(raw) };
  } catch (err) {
    throw new Error(`Corrupt queue file ${file}: ${err.message}`);
  }
}

function save(queue, file = paths.queueFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(queue, null, 2));
  fs.renameSync(tmp, file);
}

function newItem(f, day) {
  return {
    id: idOf(f.key), key: f.key, rule: f.rule, severity: f.severity, title: f.summary,
    first_seen: day, last_seen: day, seen_days: [], hits: 0, sessions: 0, hitIds: [], examples: [],
  };
}

function addHit(item, f, day) {
  const hitId = `${f.session}|${day}`;
  if (item.hitIds.includes(hitId)) return;
  item.hitIds.push(hitId);
  item.hits = item.hitIds.length;
  item.sessions = new Set(item.hitIds.map((h) => h.split('|')[0])).size;
  item.seen_days = [...new Set([...item.seen_days, day])].sort();
  item.first_seen = item.seen_days[0];
  item.last_seen = item.seen_days[item.seen_days.length - 1];
  const example = { session: f.session, day, hook: f.hook, summary: f.summary, evidence: f.evidence };
  item.examples = [example, ...item.examples].slice(0, MAX_EXAMPLES);
}

function takeFrom(list, key) {
  const i = list.findIndex((it) => it.key === key);
  return i < 0 ? null : list.splice(i, 1)[0];
}

function upsert(queue, findings) {
  for (const f of findings) {
    if (queue.dismissed.some((d) => d.key === f.key)) continue;
    const day = paths.localDay(f.ts);
    let item = queue.open.find((it) => it.key === f.key);
    if (!item) {
      const resolved = queue.resolved.find((it) => it.key === f.key);
      if (resolved && !(new Date(f.ts) > new Date(resolved.resolved_at))) continue;
      item = takeFrom(queue.resolved, f.key);
      if (item) {
        delete item.resolved_at;
        item.reopened = true;
      } else {
        item = takeFrom(queue.expired, f.key) || newItem(f, day);
      }
      queue.open.push(item);
    }
    addHit(item, f, day);
  }
  return queue;
}

function find(queue, id) {
  const item = queue.open.find((it) => it.id === id);
  if (!item) throw new Error(`No open queue item with id ${id}`);
  return item;
}

function resolve(queue, id, note, nowIso) {
  const item = find(queue, id);
  queue.open = queue.open.filter((it) => it !== item);
  queue.resolved.push({ ...item, resolved_at: nowIso, note });
  return { key: item.key, rule: item.rule, date: paths.localDay(nowIso), resolved_at: nowIso, note };
}

function dismiss(queue, id, reason, nowIso) {
  const item = find(queue, id);
  queue.open = queue.open.filter((it) => it !== item);
  queue.dismissed.push({ key: item.key, reason, at: nowIso });
  return queue;
}

function expire(queue, today, days) {
  const daysBetween = (a) => (new Date(`${today}T00:00:00`) - new Date(`${a}T00:00:00`)) / DAY_MS;
  const stale = queue.open.filter((it) => daysBetween(it.last_seen) > days);
  queue.open = queue.open.filter((it) => !stale.includes(it));
  queue.expired.push(...stale);
  return queue;
}

function ordered(queue) {
  const score = (it) => (WEIGHT[it.severity] || 0) * it.seen_days.length;
  return [...queue.open].sort((a, b) => score(b) - score(a) || (a.last_seen < b.last_seen ? 1 : a.last_seen > b.last_seen ? -1 : 0));
}

module.exports = { load, save, upsert, resolve, dismiss, expire, ordered };
