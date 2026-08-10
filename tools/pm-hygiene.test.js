#!/usr/bin/env node
/**
 * pm-hygiene.test.js — Tests for PM hygiene tool.
 * Run with: node --test tools/pm-hygiene.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// #351: AGENT_SESSION_LOG override (see tools/pm-hygiene.js) keeps this test off the real,
// shared ~/agent-memory/nexus/session-log.jsonl — CLAUDE.md: never write there outside
// documented tools/paths. It must be set BEFORE the module is imported, since SESSION_LOG is
// resolved once at module load.
const dir = mkdtempSync(join(tmpdir(), 'pm-hygiene-test-'));
const logPath = join(dir, 'session-log.jsonl');
process.env.AGENT_SESSION_LOG = logPath;

const { appendSessionSummary, SESSION_LOG } = await import('./pm-hygiene.js');

test('SESSION_LOG resolves to the AGENT_SESSION_LOG override, not the real nexus path', () => {
  assert.equal(SESSION_LOG, logPath);
});

// #351 root cause: this used to filter out any existing row for `sessionId` and push a
// summary-only replacement, discarding cost_usd/in_tok/out_tok/agent that session-end.sh had
// just written for the same session moments earlier in the same Stop-hook invocation.
test('appendSessionSummary: merges onto an existing row for the session instead of replacing it', () => {
  const sessionId = 'sess-merge-test';
  const existingRow = { ts: '2026-08-01T00:00:00.000Z', session: sessionId, agent: 'Friday', cost_usd: 0.42, in_tok: 100, out_tok: 50 };
  writeFileSync(logPath, JSON.stringify(existingRow) + '\n', 'utf8');

  appendSessionSummary(sessionId, 'did the thing [clean]', '/repo');

  const rows = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(rows.length, 1, 'must merge onto the existing row, not append a second one');
  const row = rows[0];
  assert.equal(row.cost_usd, 0.42, 'cost_usd from session-end.sh must survive the merge');
  assert.equal(row.in_tok, 100);
  assert.equal(row.out_tok, 50);
  assert.equal(row.agent, 'Friday');
  assert.equal(row.summary, 'did the thing [clean]');
  assert.equal(row.cwd, '/repo');
});

test('appendSessionSummary: appends a new row when no existing row matches the session', () => {
  writeFileSync(logPath, '', 'utf8');
  appendSessionSummary('sess-new', 'first summary [clean]', '/repo2');
  const rows = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session, 'sess-new');
  assert.equal(rows[0].summary, 'first summary [clean]');
});

test('appendSessionSummary: two calls for two different sessions produce two distinct rows', () => {
  writeFileSync(logPath, '', 'utf8');
  appendSessionSummary('sess-a', 'summary a [clean]', '/repo-a');
  appendSessionSummary('sess-b', 'summary b [clean]', '/repo-b');
  const rows = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.session).sort(), ['sess-a', 'sess-b']);
});
