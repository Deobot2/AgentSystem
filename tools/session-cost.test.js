import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionLog, rowDate, dedupeSessions, checkSessionLog } from './session-cost.js';

test('parseSessionLog: parses valid JSONL rows', () => {
  const text = '{"a":1}\n{"a":2}\n';
  const { rows, totalLines } = parseSessionLog(text);
  assert.equal(totalLines, 2);
  assert.equal(rows.length, 2);
});

test('parseSessionLog: skips malformed lines but counts them in totalLines', () => {
  const text = 'not json\n{"a":1}\n';
  const { rows, totalLines } = parseSessionLog(text);
  assert.equal(totalLines, 2);
  assert.equal(rows.length, 1);
});

test('parseSessionLog: empty text yields zero lines and zero rows', () => {
  const { rows, totalLines } = parseSessionLog('');
  assert.equal(totalLines, 0);
  assert.equal(rows.length, 0);
});

// #351: reader used to filter on `s.ts` exclusively; rows written with only `timestamp`
// (e.g. the pre-fix tools/pm-hygiene.js summary-only rows) were invisible to every
// date-scoped report because `new Date(undefined) >= cutoff` is always false.
test('rowDate: resolves `ts` when present', () => {
  const d = rowDate({ ts: '2026-08-01T00:00:00.000Z' });
  assert.equal(d.toISOString(), '2026-08-01T00:00:00.000Z');
});

test('rowDate: falls back to `timestamp` when `ts` is absent', () => {
  const d = rowDate({ timestamp: '2026-08-01T00:00:00.000Z' });
  assert.equal(d.toISOString(), '2026-08-01T00:00:00.000Z');
});

test('rowDate: neither key present yields an Invalid Date, not a thrown error', () => {
  const d = rowDate({});
  assert.ok(Number.isNaN(d.getTime()));
});

test('dedupeSessions: collapses exact-duplicate rows', () => {
  const rows = [
    { session: 's1', ts: 't1', cost_usd: 0.1, in_tok: 10, out_tok: 5 },
    { session: 's1', ts: 't1', cost_usd: 0.1, in_tok: 10, out_tok: 5 },
    { session: 's2', ts: 't2', cost_usd: 0.2, in_tok: 20, out_tok: 10 },
  ];
  const deduped = dedupeSessions(rows);
  assert.equal(deduped.length, 2);
});

// #351: --check must not fail on a quiet week (no file / empty file), only on input that
// exists but parses/joins to nothing.
test('checkSessionLog: empty text is NOT blind (quiet week, not a failure)', () => {
  const result = checkSessionLog('');
  assert.equal(result.blind, false);
});

test('checkSessionLog: content present but every line malformed IS blind', () => {
  const result = checkSessionLog('not json\nalso not json\n');
  assert.equal(result.blind, true);
  assert.match(result.reason, /0 parsed as valid JSON/);
});

test('checkSessionLog: rows parsed but none carry a resolvable date IS blind (the #351 bug)', () => {
  // Mirrors the exact #351 failure: 145 rows existed, none carried a `ts` the reader could use.
  const text = JSON.stringify({ session: 's1', summary: 'x', cwd: '/repo' }) + '\n';
  const result = checkSessionLog(text);
  assert.equal(result.blind, true);
  assert.match(result.reason, /none carry a resolvable/);
});

test('checkSessionLog: at least one row with a resolvable date is NOT blind', () => {
  const text = JSON.stringify({ ts: '2026-08-01T00:00:00.000Z', session: 's1', cost_usd: 0.1 }) + '\n';
  const result = checkSessionLog(text);
  assert.equal(result.blind, false);
  assert.equal(result.datedRows, 1);
});

test('checkSessionLog: legacy timestamp-only rows count as resolvable (reader tolerance)', () => {
  const text = JSON.stringify({ timestamp: '2026-08-01T00:00:00.000Z', session: 's1' }) + '\n';
  const result = checkSessionLog(text);
  assert.equal(result.blind, false);
});
