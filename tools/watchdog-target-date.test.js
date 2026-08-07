import assert from 'node:assert/strict';
import { test } from 'node:test';

import { targetDate } from './watchdog-target-date.js';

// Issue #254: watchdog fired at 2026-08-07T00:49Z (4h49m late past midnight) and judged
// 2026-08-07 — a day whose 05:00/13:00 triage slots hadn't run yet — instead of 2026-08-06,
// whose window had actually closed.
test('late fire past midnight evaluates the previous day', () => {
  assert.equal(targetDate(new Date('2026-08-07T00:49:00Z')), '2026-08-06');
});

// On-time fire (nominal 20:00 UTC schedule) must still evaluate today, or the fix just shifts
// the bug by a day instead of fixing it.
test('on-time fire evaluates the same day', () => {
  assert.equal(targetDate(new Date('2026-08-07T20:00:00Z')), '2026-08-07');
});

// A fire that's late but hasn't crossed midnight (20:00 -> 23:00) is unaffected.
test('late but same-day fire evaluates the same day', () => {
  assert.equal(targetDate(new Date('2026-08-07T23:00:00Z')), '2026-08-07');
});

// Exactly at the 13:00 UTC boundary: that slot has just closed, so today counts.
test('fire exactly at 13:00 UTC evaluates the same day', () => {
  assert.equal(targetDate(new Date('2026-08-07T13:00:00Z')), '2026-08-07');
});

// Just before the boundary: the 13:00 slot has not closed yet, so yesterday counts.
test('fire just before 13:00 UTC evaluates the previous day', () => {
  assert.equal(targetDate(new Date('2026-08-07T12:59:59Z')), '2026-08-06');
});
