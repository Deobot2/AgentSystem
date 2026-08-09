import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  decide, DEFAULT_MAX_AGE_HOURS,
  heartbeatPath, writeHeartbeat, readHeartbeat,
  decideHeartbeatFreshness, DEFAULT_HEARTBEAT_MAX_AGE_HOURS,
} from './actions-watchdog.js';

const NOW = new Date('2026-08-06T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

test('healthy when Actions is enabled and a run is recent', () => {
  const v = decide({ enabled: true, newestRunAt: hoursAgo(2), now: NOW });
  assert.equal(v.down, false);
  assert.ok(Math.abs(v.ageHours - 2) < 0.01);
});

test('down when Actions is disabled repo-wide, even with a fresh run behind it', () => {
  // The five-day outage in #197: runs existed right up to the disable, so freshness alone
  // would have called it healthy for a full day.
  const v = decide({ enabled: false, newestRunAt: hoursAgo(0.5), now: NOW });
  assert.equal(v.down, true);
  assert.match(v.reason, /disabled at the repository level/);
});

test('down when enabled but the newest run is past the budget — a dead runner looks like this', () => {
  const v = decide({ enabled: true, newestRunAt: hoursAgo(DEFAULT_MAX_AGE_HOURS + 1), now: NOW });
  assert.equal(v.down, true);
  assert.match(v.reason, /newest workflow run is/);
});

test('the twice-daily job floor does not false-alarm', () => {
  // Longest legitimate gap: daily-triage at 05:00 and 13:00 UTC leaves a ~16h quiet stretch.
  assert.equal(decide({ enabled: true, newestRunAt: hoursAgo(16), now: NOW }).down, false);
});

test('down when there are no runs at all', () => {
  assert.equal(decide({ enabled: true, newestRunAt: null, now: NOW }).down, true);
});

test('down on an unparseable run timestamp rather than silently healthy', () => {
  const v = decide({ enabled: true, newestRunAt: 'not-a-date', now: NOW });
  assert.equal(v.down, true);
});

// ---------------------------------------------------------------------- heartbeat (#313)
//
// All of these pass an explicit `path`/`root` override so nothing here ever touches the real
// ~/agent-memory checkout.

test('writeHeartbeat / readHeartbeat round trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'actions-watchdog-hb-'));
  try {
    const path = join(dir, 'heartbeat.json');
    const written = writeHeartbeat({ verdict: 'healthy', ageHours: 2.5, path, now: NOW });
    assert.equal(written.verdict, 'healthy');
    const read = readHeartbeat(path);
    assert.deepEqual(read, written);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readHeartbeat returns null when the file is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'actions-watchdog-hb-'));
  try {
    const path = join(dir, 'nope.json');
    assert.equal(existsSync(path), false);
    assert.equal(readHeartbeat(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('per-host isolation: writing host-b heartbeat never touches host-a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'actions-watchdog-hb-'));
  try {
    const pathA = heartbeatPath('host-a', dir);
    const pathB = heartbeatPath('host-b', dir);
    assert.notEqual(pathA, pathB);
    writeHeartbeat({ verdict: 'healthy', host: 'host-a', path: pathA, now: NOW });
    assert.equal(existsSync(pathB), false);
    writeHeartbeat({ verdict: 'down', host: 'host-b', path: pathB, now: NOW });
    const a = readHeartbeat(pathA);
    const b = readHeartbeat(pathB);
    assert.equal(a.host, 'host-a');
    assert.equal(a.verdict, 'healthy');
    assert.equal(b.host, 'host-b');
    assert.equal(b.verdict, 'down');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('freshness: stale when heartbeat is null (never ran)', () => {
  const v = decideHeartbeatFreshness({ heartbeat: null, now: NOW });
  assert.equal(v.stale, true);
  assert.match(v.reason, /no actions-watchdog heartbeat found/);
});

test('freshness: fresh within budget', () => {
  const heartbeat = { timestamp: new Date(NOW.getTime() - 1 * 3_600_000).toISOString() };
  const v = decideHeartbeatFreshness({ heartbeat, now: NOW, maxAgeHours: DEFAULT_HEARTBEAT_MAX_AGE_HOURS });
  assert.equal(v.stale, false);
  assert.ok(Math.abs(v.ageHours - 1) < 0.01);
});

test('freshness: stale past budget — the hourly timer looks dead', () => {
  const heartbeat = { timestamp: new Date(NOW.getTime() - (DEFAULT_HEARTBEAT_MAX_AGE_HOURS + 1) * 3_600_000).toISOString() };
  const v = decideHeartbeatFreshness({ heartbeat, now: NOW, maxAgeHours: DEFAULT_HEARTBEAT_MAX_AGE_HOURS });
  assert.equal(v.stale, true);
  assert.match(v.reason, /heartbeat is .*h old/);
});

test('freshness: stale on an unparseable heartbeat timestamp', () => {
  const heartbeat = { timestamp: 'not-a-date' };
  const v = decideHeartbeatFreshness({ heartbeat, now: NOW });
  assert.equal(v.stale, true);
  assert.match(v.reason, /unparseable/);
});
