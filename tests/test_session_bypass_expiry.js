/**
 * tests/test_session_bypass_expiry.js
 * node --test tests/test_session_bypass_expiry.js
 *
 * Regression coverage for session-only bypasses that never expire.
 * Bug: `node tools/routines.js bypass <id> --session` wrote an override that persisted
 * indefinitely to routine-overrides.json, with no session-id check. A 3-week-old
 * "session-only" bypass from a past session would still suppress a routine in a new session.
 *
 * Fix: stamp the override with a sessionId at write time, check for session-id match at read time,
 * and treat ambiguous/missing session-ids as NOT active (fail-closed).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const ROUTINES_JS = join(REPO_ROOT, 'tools', 'routines.js');
const OVERRIDES_PATH = join(homedir(), 'agent-memory', 'nexus', 'routine-overrides.json');
const HOOK = join(REPO_ROOT, 'hooks', 'routines-context-inject.js');

function runRoutinesTool(args, env = {}) {
  const nodeEnv = { ...process.env, ...env };
  return execFileSync('node', [ROUTINES_JS, ...args], {
    encoding: 'utf8',
    env: nodeEnv,
  });
}

function runHook(payload, sessionId = null) {
  const input = JSON.stringify(payload);
  // Pass session_id in the JSON payload, as hooks receive it on stdin
  const payloadWithSession = sessionId
    ? { ...payload, session_id: sessionId }
    : payload;
  return execFileSync('node', [HOOK], {
    input: JSON.stringify(payloadWithSession),
    encoding: 'utf8',
  });
}

function writeOverridesFile(overrides) {
  mkdirSync(dirname(OVERRIDES_PATH), { recursive: true });
  writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 2) + '\n', 'utf8');
}

function readOverridesFile() {
  try {
    return JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
  } catch {
    return {};
  }
}

describe('Session-only bypasses expire with session id checks', () => {
  it('a session bypass written with session-id A is NOT active when read from session B (regression)', () => {
    // Setup: write a session bypass with sessionId="session-A"
    const override = {
      'test-routine': {
        bypassed: true,
        session: true,
        sessionId: 'session-A',
        at: new Date().toISOString(),
      },
    };
    writeOverridesFile(override);

    // Read the hook with a different sessionId="session-B"
    // The routine should NOT be in the bypassed list
    const out = runHook({}, 'session-B');

    // The bypass from session-A should NOT appear in the output
    assert.ok(!out.includes('test-routine'), `Expected routine not bypassed in new session, but output was: ${out}`);
  });

  it('a session bypass with no recorded sessionId is NOT honored (fail-closed)', () => {
    // Setup: write a session bypass with sessionId=null (no session recorded)
    const override = {
      'test-routine': {
        bypassed: true,
        session: true,
        sessionId: null,
        at: new Date().toISOString(),
      },
    };
    writeOverridesFile(override);

    // Read from any session
    const out = runHook({}, 'any-session');

    // The ambiguous bypass should NOT be honored
    assert.ok(!out.includes('test-routine'), `Expected routine not bypassed when sessionId is null, but output was: ${out}`);
  });

  it('a non-session bypass (session=false) is unaffected and remains permanent', () => {
    // Setup: write a non-session bypass (permanent)
    const override = {
      'test-routine': {
        bypassed: true,
        session: false,
        at: new Date().toISOString(),
      },
    };
    writeOverridesFile(override);

    // Read from any session
    const out = runHook({}, 'any-session');

    // The permanent bypass SHOULD be honored even in a different/new session
    assert.ok(out.includes('test-routine'), `Expected routine bypassed (non-session), but output was: ${out}`);
  });

  it('a session bypass written with sessionId matches when read from the same session', () => {
    // Setup: write a session bypass with sessionId="session-A"
    const override = {
      'test-routine': {
        bypassed: true,
        session: true,
        sessionId: 'session-A',
        at: new Date().toISOString(),
      },
    };
    writeOverridesFile(override);

    // Read from the SAME session
    const out = runHook({}, 'session-A');

    // The bypass from same session SHOULD be honored
    assert.ok(out.includes('test-routine'), `Expected routine bypassed in same session, but output was: ${out}`);
  });

  // Note: cmdBypass tests with actual routines are tested via integration with real routines.
  // These are the core hook-level tests verifying session-id expiry behavior.
});
