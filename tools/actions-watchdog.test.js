import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, DEFAULT_MAX_AGE_HOURS } from './actions-watchdog.js';

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
