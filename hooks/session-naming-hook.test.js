#!/usr/bin/env node
'use strict';
/**
 * Test suite for session-naming-hook.js
 * Tests SessionStart hook behavior for session registration and title output.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDir = path.join(os.tmpdir(), `session-naming-test-${Date.now()}`);
const hookPath = path.join(__dirname, 'session-naming-hook.js');

test('setup', () => {
  fs.mkdirSync(testDir, { recursive: true });
});

test('session-naming-hook: hook structure is correct', () => {
  // Verify the hook file exists and is readable
  assert(fs.existsSync(hookPath), 'session-naming-hook.js should exist');
  const content = fs.readFileSync(hookPath, 'utf8');
  assert(content.includes('SessionStart'), 'Hook should reference SessionStart');
  assert(content.includes('session-namer.js'), 'Hook should call session-namer.js');
});

test('session-naming-hook: handles malformed JSON input gracefully', () => {
  // Genuinely invalid JSON on stdin. The hook's JSON.parse must throw, be
  // caught, and the hook must still print 'OK' and exit 0 — never emit a
  // stack trace, which would indicate an uncaught exception reaching the
  // harness. Point AGENT_TOOLS_ROOT at an empty temp dir so this can never
  // fall through to touching the real ~/dev/AgentSystem/tools.
  const result = spawnSync(process.execPath, [hookPath], {
    input: '{this is not valid json,,,',
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, AGENT_TOOLS_ROOT: testDir },
  });

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  assert.equal(result.stdout.trim(), 'OK', `expected stdout 'OK', got: ${result.stdout}`);
  assert.equal(result.stderr.trim(), '', `expected no stderr/stack trace, got: ${result.stderr}`);

  // Empty stdin is likewise invalid JSON input and must be handled the same way.
  const result2 = spawnSync(process.execPath, [hookPath], {
    input: '',
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, AGENT_TOOLS_ROOT: testDir },
  });
  assert.equal(result2.status, 0);
  assert.equal(result2.stdout.trim(), 'OK');
  assert.equal(result2.stderr.trim(), '');
});

test('cleanup', () => {
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
});
