#!/usr/bin/env node
'use strict';
/**
 * Test suite for session-hygiene-hook.js
 * Tests SessionEnd hook behavior for session finalization and logging.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const testDir = path.join(os.tmpdir(), `session-hygiene-test-${Date.now()}`);
const hookPath = path.join(__dirname, 'session-hygiene-hook.js');

test('setup', () => {
  fs.mkdirSync(testDir, { recursive: true });
});

test('session-hygiene-hook: hook structure is correct', () => {
  // Verify the hook file exists and is readable
  assert(fs.existsSync(hookPath), 'session-hygiene-hook.js should exist');
  const content = fs.readFileSync(hookPath, 'utf8');
  assert(content.includes('SessionEnd'), 'Hook should reference SessionEnd');
  assert(content.includes('session-namer.js'), 'Hook should call session-namer.js');
  assert(content.includes('session-log-append.js'), 'Hook should call session-log-append.js');
});

test('session-hygiene-hook: handles missing payload gracefully', () => {
  // Empty stdin -> JSON.parse('') throws -> hook must catch it, print OK,
  // exit 0, and must not blow up with a stack trace on stderr.
  const result = spawnSync(process.execPath, [hookPath], {
    input: '',
    encoding: 'utf8',
    timeout: 5000,
  });

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  assert.equal(result.stdout.trim(), 'OK', `expected stdout 'OK', got: ${result.stdout}`);
  assert.equal(result.stderr.trim(), '', `expected no stderr output, got: ${result.stderr}`);

  // Also cover a payload that parses as JSON but has no session_id — same
  // "exit cleanly" path via the `if (!sessionId || !TOOLS)` guard.
  const result2 = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ cwd: testDir }),
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result2.status, 0);
  assert.equal(result2.stdout.trim(), 'OK');
  assert.equal(result2.stderr.trim(), '');
});

test('session-hygiene-hook: spawns detached worker without blocking', () => {
  // Point the hook at a fake tools dir (via AGENT_TOOLS_ROOT) so it never
  // touches the real ~/dev/AgentSystem/tools or ~/agent-memory state.
  const fakeToolsDir = path.join(testDir, 'fake-tools');
  fs.mkdirSync(fakeToolsDir, { recursive: true });

  const markerPath = path.join(testDir, 'finalize-close.marker');
  const workerDelayMs = 700;

  // Fake session-namer.js: when called with --finalize-close, sleep past
  // the parent's expected return time, then drop a marker file. If the
  // parent hook were blocking on this, the parent process itself would
  // take >= workerDelayMs to return — which the assertions below check for.
  const fakeSessionNamer = `
    const fs = require('fs');
    const args = process.argv.slice(2);
    if (args.includes('--finalize-close')) {
      const start = Date.now();
      while (Date.now() - start < ${workerDelayMs}) { /* busy-wait */ }
      fs.writeFileSync(${JSON.stringify(markerPath)}, String(Date.now()));
    }
    process.exit(0);
  `;
  fs.writeFileSync(path.join(fakeToolsDir, 'session-namer.js'), fakeSessionNamer, 'utf8');
  fs.writeFileSync(path.join(fakeToolsDir, 'session-log-append.js'), 'process.exit(0);', 'utf8');

  const sessionId = crypto.randomUUID();
  // Use a cwd that is not the repo itself so `git status --porcelain` either
  // no-ops or fails harmlessly, and never touches real repo state.
  const fakeCwd = path.join(testDir, 'fake-repo');
  fs.mkdirSync(fakeCwd, { recursive: true });

  const start = Date.now();
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ session_id: sessionId, cwd: fakeCwd }),
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, AGENT_TOOLS_ROOT: fakeToolsDir },
  });
  const elapsed = Date.now() - start;

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  assert.equal(result.stdout.trim(), 'OK');
  // The parent must return well before the worker's simulated work finishes —
  // proof it did not wait on the detached child.
  assert(
    elapsed < workerDelayMs * 0.7,
    `hook took ${elapsed}ms to return; expected it to return immediately without waiting for the ${workerDelayMs}ms worker`
  );
  assert(!fs.existsSync(markerPath), 'worker marker should not exist yet — parent must not have waited for it');

  // Now poll for the marker to prove the detached worker actually ran (it's
  // not just fire-and-forget-into-the-void).
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(markerPath) && Date.now() < deadline) {
    // Busy-poll in short increments; this is a test, not production code.
    const waitUntil = Date.now() + 50;
    while (Date.now() < waitUntil) { /* spin */ }
  }
  assert(fs.existsSync(markerPath), 'detached worker never ran --finalize-close');
});

test('cleanup', () => {
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
});
