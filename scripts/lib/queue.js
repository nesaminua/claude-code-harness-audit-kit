'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const paths = require('./paths.js');
const { writePrivate } = require('./private-write.js');

const WEIGHT = { high: 3, medium: 2, low: 1 };
const MAX_EXAMPLES = 3;
const DAY_MS = 86400000;

const emptyQueue = () => ({ version: 1, open: [], resolved: [], expired: [], dismissed: [] });
const idOf = (key) => crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Valid JSON that is not an object (null, an array, a number) cannot be repaired by the next write,
// so it is moved aside like a corrupt file and the queue starts empty.
function moveAside(file, what, onWarn) {
  const moved = `${file}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(file, moved);
    onWarn(`${path.basename(file)} ${what} and was moved to ${path.basename(moved)}; the queue starts empty`);
  } catch (err) {
    onWarn(`${path.basename(file)} ${what} and could not be moved (${err.code}); the queue starts empty`);
  }
  return emptyQueue();
}

const LISTS = ['open', 'resolved', 'expired', 'dismissed'];
const isKeyed = (i) => isPlainObject(i) && typeof i.key === 'string';
const isOpenItem = (i) => isKeyed(i) && ['hitIds', 'seen_days', 'examples'].every((f) => Array.isArray(i[f]));
// resolved and expired items come back through upsert, so they obey the open-item rule

// A list that is not an array makes the whole file corrupt (null); a malformed item is dropped on its own.
function checkedShape(parsed, onWarn) {
  const queue = { ...emptyQueue(), ...parsed };
  if (LISTS.some((list) => !Array.isArray(queue[list]))) return null;
  let dropped = 0;
  for (const list of LISTS) {
    const kept = queue[list].filter(list === 'dismissed' ? isKeyed : isOpenItem);
    dropped += queue[list].length - kept.length;
    queue[list] = kept;
  }
  if (dropped) onWarn(`queue.json: dropped ${dropped} malformed item(s)`);
  return queue;
}

function load(file = paths.queueFile(), onWarn = () => {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyQueue();
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Corrupt queue file ${file}: ${err.message}`);
  }
  if (!isPlainObject(parsed)) {
    const shape = parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : `a ${typeof parsed}`;
    return moveAside(file, `held ${shape} instead of an object`, onWarn);
  }
  return checkedShape(parsed, onWarn) || moveAside(file, 'had a list (open, resolved, expired or dismissed) that is not an array', onWarn);
}

function save(queue, file = paths.queueFile()) {
  writePrivate(file, JSON.stringify(queue, null, 2));
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

const ITEM_ARRAYS = ['hitIds', 'seen_days', 'examples'];

// An item reopened from resolved/expired may come from an older or hand-edited file.
function withArrays(item) {
  for (const field of ITEM_ARRAYS) if (!Array.isArray(item[field])) item[field] = [];
  return item;
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
    addHit(withArrays(item), f, day);
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
