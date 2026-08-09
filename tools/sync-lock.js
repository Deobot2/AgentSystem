#!/usr/bin/env node
// sync-lock.js — a small time-based file lock, shared by the continuous-sync runners (#341).
//
// Why this exists: memory sync now has three triggers — SessionStart, SessionEnd, and a ~15 minute
// host timer — all of which can fire in the same second on the same checkout. `brain-sync.js` runs
// `git add -A`, `git commit`, `git pull` and `git push` against one working tree; two of those
// overlapping is not a merge conflict, it is a corrupted index, and it surfaces later as a
// "conflict needing a human" on some unrelated job (#341, #340).
//
// Staleness is time-based rather than pid-based on purpose. A pid check is not portable — Windows
// reuses pids freely and `process.kill(pid, 0)` means something different under a service account —
// and the thing being guarded either finishes in seconds or has already gone wrong. A lock older
// than the window is assumed abandoned and taken over.
//
// Release is token-checked: if we went stale and someone else took the lock over, our late release
// must not delete their record. That is the one race a naive `unlink` gets wrong.
//
// Node builtins only (repo rule for tools/).

import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

/**
 * Default: longer than a normal sync, shorter than the 15-minute timer interval.
 *
 * This bound is only safe because the caller also bounds the work it does while holding the lock —
 * see BUDGET_FRACTION below. A lock window shorter than the job it protects means the next trigger
 * steals the lock out from under a `git push` that is merely slow, which is the exact overlap the
 * lock exists to prevent.
 */
export const DEFAULT_STALE_MS = 10 * 60 * 1000;

/**
 * How much of the stale window the holder may actually spend working. The remainder is slack for
 * process startup and for the holder to notice its own timeout and release.
 */
export const BUDGET_FRACTION = 0.8;

/** The wall-clock budget a holder gets, given the stale window it acquired under. */
export function workBudgetMs(staleMs = DEFAULT_STALE_MS) {
  return Math.max(1000, Math.floor(staleMs * BUDGET_FRACTION));
}

/** Block for `ms` without a dependency or an event loop turn. */
function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The holder record in `file`, or null when absent or unparseable. */
export function readLock(file) {
  try {
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    return rec && typeof rec === 'object' ? rec : null;
  } catch {
    return null;
  }
}

/**
 * True when a holder record should be ignored: missing, undated, or older than the window.
 * A half-written or hand-mangled lock file reads as stale — a lock nobody can ever clear is a
 * worse outage than the race it prevents.
 */
export function isStale(rec, { staleMs = DEFAULT_STALE_MS, now = Date.now() } = {}) {
  if (!rec) return true;
  const at = Date.parse(rec.at);
  if (!Number.isFinite(at)) return true;
  return now - at >= staleMs;
}

/**
 * Try to take `file`.
 * @returns {{acquired: true, token: string} | {acquired: false, holder: object|null}}
 */
export function acquireLock(
  file,
  { staleMs = DEFAULT_STALE_MS, now = Date.now(), meta = {}, settleMs = 50 } = {},
) {
  const token = JSON.stringify({
    pid: process.pid, host: hostname(), at: new Date(now).toISOString(), id: randomUUID(), ...meta,
  });
  try { mkdirSync(dirname(file), { recursive: true }); } catch { /* already there */ }

  try {
    writeFileSync(file, token, { flag: 'wx' }); // atomic create-or-fail
    return { acquired: true, token };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const holder = readLock(file);
  if (!isStale(holder, { staleMs, now })) return { acquired: false, holder };

  // Taking over a stale lock, atomically. The obvious version — rm, then create with 'wx' — is a
  // TOCTOU: two processes both see the same stale record, A removes it and creates its own, and B's
  // rm then deletes A's *fresh* lock before creating its own. Both believe they hold it, and two
  // brain-syncs in one working tree is exactly the corruption the lock exists to prevent.
  //
  // Instead: write a private file and rename it over the lock. Rename is atomic and last-writer-
  // wins, so after both racers have renamed, the file holds exactly one token. Settle, then read it
  // back — whoever's token is not there lost and backs off, rather than both proceeding.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, token);
    renameSync(tmp, file);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean up */ }
    return { acquired: false, holder: readLock(file) };
  }

  sleepSync(settleMs);
  let onDisk = null;
  try { onDisk = readFileSync(file, 'utf8'); } catch { /* vanished under us */ }
  if (onDisk !== token) return { acquired: false, holder: readLock(file) };
  return { acquired: true, token };
}

/** Release `file`, but only if it still carries our token. */
export function releaseLock(file, token) {
  try {
    if (readFileSync(file, 'utf8') !== token) return false;
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}
