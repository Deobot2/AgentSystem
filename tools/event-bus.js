// event-bus.js — unified, durable event queue for the agent system.
//
// Every async trigger in the system (GitHub webhook routes, hook-scheduled jobs, cron
// followups) previously fired its side effect directly; a skipped spawn (dedupe window,
// concurrency cap), a dead Task Scheduler entry, or a crashed process silently LOST the
// event. This bus makes triggers durable: producers publish a small JSON event, a
// dispatcher (tools/event-dispatcher.js) drains the queue with retries + exponential
// backoff, and events that exhaust their attempts land in a dead-letter log with an
// alert record instead of vanishing.
//
// Storage layout (default root ~/agent-memory/nexus/events/, override for tests):
//   queue/<seq>.json    — pending events (atomic tmp+rename writes)
//   processing/         — claimed events (atomic claim via rename)
//   done.jsonl          — completed events, append-only
//   dead-letter.jsonl   — events that exhausted maxAttempts, append-only
//   alerts.jsonl        — one alert record per dead-lettered event, append-only
//
// Event shape:
//   { id, ts, type, source, payload, attempts, maxAttempts, nextAttemptAt, lastError }
//
// No npm deps — Node builtins only (tools/ rule). ESM like the rest of tools/.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isMainModule } from './is-main.js';

const DEFAULT_ROOT = path.join(os.homedir(), 'agent-memory', 'nexus', 'events');
export const DEFAULT_MAX_ATTEMPTS = 3;
export const BACKOFF_BASE_MS = 60 * 1000; // 1min, 2min, 4min...

export function eventRoot(root) {
  return root || process.env.AGENT_EVENT_ROOT || DEFAULT_ROOT;
}

export function dirs(root) {
  const r = eventRoot(root);
  return {
    root: r,
    queue: path.join(r, 'queue'),
    processing: path.join(r, 'processing'),
    done: path.join(r, 'done.jsonl'),
    dead: path.join(r, 'dead-letter.jsonl'),
    alerts: path.join(r, 'alerts.jsonl'),
  };
}

function ensureDirs(root) {
  const d = dirs(root);
  fs.mkdirSync(d.queue, { recursive: true });
  fs.mkdirSync(d.processing, { recursive: true });
  return d;
}

function appendJsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

// Validation at the publish boundary (CLI + programmatic callers, including the
// webhook-server producer): type must be a known handler id, payload must be a
// plain object under a size cap. Keeps attacker-shaped input out of the queue.
export const KNOWN_TYPES = ['run-tool', 'spawn-agent', 'noop'];
let publishSeq = 0;
export const MAX_PAYLOAD_BYTES = 64 * 1024;

// Publish an event. `type` must be in KNOWN_TYPES; payload is handler-specific.
// Returns the full stored event. Filename is <ts-ms>-<id>.json so directory
// order equals FIFO order.
export function publish(evt, root) {
  if (!evt || !evt.type) throw new Error('event requires a type');
  if (!KNOWN_TYPES.includes(evt.type)) {
    throw new Error(`unknown event type "${evt.type}" — allowed: ${KNOWN_TYPES.join(', ')}`);
  }
  if (evt.payload !== undefined &&
      (typeof evt.payload !== 'object' || evt.payload === null || Array.isArray(evt.payload))) {
    throw new Error('event payload must be a plain object');
  }
  const payloadBytes = Buffer.byteLength(JSON.stringify(evt.payload || {}));
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    throw new Error(`event payload too large: ${payloadBytes} bytes (max ${MAX_PAYLOAD_BYTES})`);
  }
  const d = ensureDirs(root);
  const now = Date.now();
  const event = {
    id: evt.id || crypto.randomBytes(6).toString('hex'),
    ts: new Date(now).toISOString(),
    type: evt.type,
    source: evt.source || 'unknown',
    payload: evt.payload || {},
    attempts: 0,
    maxAttempts: Number.isInteger(evt.maxAttempts) ? evt.maxAttempts : DEFAULT_MAX_ATTEMPTS,
    nextAttemptAt: evt.nextAttemptAt || new Date(now).toISOString(),
    lastError: null,
  };
  // Per-process counter keeps FIFO order stable when two publishes land in the
  // same millisecond — otherwise directory sort falls through to the random id.
  const seq = String(publishSeq++).padStart(6, '0');
  const file = path.join(d.queue, `${String(now).padStart(15, '0')}-${seq}-${event.id}.json`);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(event, null, 2));
  fs.renameSync(tmp, file); // atomic on same volume
  return event;
}

function readEventFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// All pending events, FIFO, including not-yet-eligible retries.
export function listPending(root) {
  const d = dirs(root);
  let files = [];
  try { files = fs.readdirSync(d.queue).filter(f => f.endsWith('.json')).sort(); } catch { return []; }
  return files
    .map(f => ({ file: path.join(d.queue, f), event: readEventFile(path.join(d.queue, f)) }))
    .filter(e => e.event);
}

// Claim the oldest eligible event (nextAttemptAt <= now) by renaming it into
// processing/. Rename is atomic, so two concurrent dispatchers can never claim
// the same event — the loser's rename throws and it moves to the next file.
// Returns { event, claimFile } or null when nothing is eligible.
export function claimNext(root, now) {
  const d = ensureDirs(root);
  const nowMs = now instanceof Date ? now.getTime() : (now || Date.now());
  for (const { file, event } of listPending(root)) {
    const eligibleAt = Date.parse(event.nextAttemptAt || 0) || 0;
    if (eligibleAt > nowMs) continue;
    const claimFile = path.join(d.processing, path.basename(file));
    try { fs.renameSync(file, claimFile); } catch { continue; } // raced — next
    return { event, claimFile };
  }
  return null;
}

// Mark a claimed event done: append to done.jsonl, remove the claim file.
export function complete(claim, root, result) {
  const d = dirs(root);
  appendJsonl(d.done, {
    ...claim.event,
    completedAt: new Date().toISOString(),
    result: result === undefined ? null : result,
  });
  try { fs.unlinkSync(claim.claimFile); } catch { /* already gone */ }
}

// Mark a claimed event failed. Below maxAttempts: requeue with exponential
// backoff. At maxAttempts: dead-letter + alert. Returns 'requeued' | 'dead'.
export function fail(claim, err, root, now) {
  const d = ensureDirs(root);
  const nowMs = now instanceof Date ? now.getTime() : (now || Date.now());
  const event = { ...claim.event };
  event.attempts += 1;
  event.lastError = String(err && err.message ? err.message : err).slice(0, 500);

  if (event.attempts >= event.maxAttempts) {
    const deadAt = new Date(nowMs).toISOString();
    appendJsonl(d.dead, { ...event, deadAt });
    appendJsonl(d.alerts, {
      ts: deadAt,
      level: 'error',
      kind: 'event-dead-letter',
      eventId: event.id,
      type: event.type,
      source: event.source,
      attempts: event.attempts,
      lastError: event.lastError,
    });
    try { fs.unlinkSync(claim.claimFile); } catch { /* already gone */ }
    return 'dead';
  }

  event.nextAttemptAt = new Date(nowMs + BACKOFF_BASE_MS * 2 ** (event.attempts - 1)).toISOString();
  const file = path.join(d.queue, path.basename(claim.claimFile));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(event, null, 2));
  fs.renameSync(tmp, file);
  try { fs.unlinkSync(claim.claimFile); } catch { /* already gone */ }
  return 'requeued';
}

// Requeue every dead-lettered event (attempts reset). Truncates dead-letter.jsonl.
export function requeueDead(root) {
  const d = dirs(root);
  let lines = [];
  try { lines = fs.readFileSync(d.dead, 'utf8').split('\n').filter(Boolean); } catch { return 0; }
  let n = 0;
  for (const line of lines) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    publish({ ...event, id: event.id, maxAttempts: event.maxAttempts }, root);
    n++;
  }
  if (n) fs.writeFileSync(d.dead, '');
  return n;
}

// Recover events stranded in processing/ by a crashed dispatcher: anything older
// than staleMs goes back to the queue for a retry (counts as a failed attempt).
export function recoverStale(root, staleMs = 15 * 60 * 1000, now) {
  const d = ensureDirs(root);
  const nowMs = now instanceof Date ? now.getTime() : (now || Date.now());
  let recovered = 0;
  let files = [];
  try { files = fs.readdirSync(d.processing).filter(f => f.endsWith('.json')); } catch { return 0; }
  for (const f of files) {
    const claimFile = path.join(d.processing, f);
    let mtime;
    try { mtime = fs.statSync(claimFile).mtimeMs; } catch { continue; }
    if (nowMs - mtime < staleMs) continue;
    const event = readEventFile(claimFile);
    if (!event) { try { fs.unlinkSync(claimFile); } catch { } continue; }
    const outcome = fail({ event, claimFile }, new Error('dispatcher crashed mid-processing (stale claim recovered)'), root, nowMs);
    if (outcome === 'requeued') {
      // A crash is not a handler failure — make the event immediately eligible
      // again instead of serving a backoff delay.
      const requeuedFile = path.join(d.queue, f);
      const requeued = readEventFile(requeuedFile);
      if (requeued) {
        requeued.nextAttemptAt = new Date(nowMs).toISOString();
        fs.writeFileSync(requeuedFile, JSON.stringify(requeued, null, 2));
      }
    }
    recovered++;
  }
  return recovered;
}

function jsonlCount(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
}

export function stats(root) {
  const d = dirs(root);
  let processing = 0;
  try { processing = fs.readdirSync(d.processing).filter(f => f.endsWith('.json')).length; } catch { }
  return {
    pending: listPending(root).length,
    processing,
    done: jsonlCount(d.done),
    dead: jsonlCount(d.dead),
    alerts: jsonlCount(d.alerts),
  };
}


// CLI: publish | list | stats | dead | requeue-dead
function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'stats';
  const flag = (name) => {
    const a = args.find(x => x.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : null;
  };
  if (cmd === 'publish') {
    let payload = {};
    try { payload = JSON.parse(flag('json') || '{}'); } catch {
      console.error('invalid --json payload'); process.exit(1);
    }
    const evt = publish({ type: flag('type'), source: flag('source') || 'cli', payload });
    console.log(`published ${evt.type} id=${evt.id}`);
  } else if (cmd === 'list') {
    for (const { event } of listPending()) {
      console.log(`${event.ts}  ${event.type}  id=${event.id}  attempts=${event.attempts}/${event.maxAttempts}  next=${event.nextAttemptAt}`);
    }
  } else if (cmd === 'dead') {
    const d = dirs();
    try {
      for (const line of fs.readFileSync(d.dead, 'utf8').split('\n').filter(Boolean)) console.log(line);
    } catch { /* empty */ }
  } else if (cmd === 'requeue-dead') {
    console.log(`requeued ${requeueDead()} dead-lettered event(s)`);
  } else {
    console.log(JSON.stringify(stats(), null, 2));
  }
}

if (isMainModule(import.meta.url)) main();
