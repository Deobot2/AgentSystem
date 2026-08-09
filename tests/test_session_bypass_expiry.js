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

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const ROUTINES_JS = join(REPO_ROOT, 'tools', 'routines.js');
const HOOK = join(REPO_ROOT, 'hooks', 'routines-context-inject.js');

// This suite must NEVER touch the real routine-overrides.json — that file is written by every
// `node tools/routines.js bypass <id>` and read by every hook on every host. A prior version of
// this suite hardcoded the real path and left a leftover "test-routine" entry there after a run.
// Route every read/write in this file through a throwaway temp path instead, via the same
// AGENT_ROUTINE_OVERRIDES_PATH env var the production code (tools/routines.js,
// hooks/routines-context-inject.js) now honors.
const TMP_DIR = join(tmpdir(), 'agentsystem-test-' + process.pid);
const OVERRIDES_PATH = join(TMP_DIR, 'routine-overrides.json');
process.env.AGENT_ROUTINE_OVERRIDES_PATH = OVERRIDES_PATH;

// REGRESSION GUARD (must stay ahead of any fix): this suite writes overrides via
// writeOverridesFile()/runHook() below; if those still target the REAL path (the confirmed
// harm — a prior run left a leftover "test-routine" entry in everyone's actual
// routine-overrides.json), this snapshot will catch the mutation.
const REAL_OVERRIDES_PATH = join(homedir(), 'agent-memory', 'nexus', 'routine-overrides.json');
let realPathExistedBefore;
let realPathContentBefore;

before(() => {
  realPathExistedBefore = existsSync(REAL_OVERRIDES_PATH);
  realPathContentBefore = realPathExistedBefore ? readFileSync(REAL_OVERRIDES_PATH, 'utf8') : null;
});

after(() => {
  const existsAfter = existsSync(REAL_OVERRIDES_PATH);
  const contentAfter = existsAfter ? readFileSync(REAL_OVERRIDES_PATH, 'utf8') : null;
  assert.equal(existsAfter, realPathExistedBefore, 'this suite must not create/remove the real routine-overrides.json');
  assert.equal(contentAfter, realPathContentBefore, 'this suite must not mutate the real routine-overrides.json');

  // Clean up the temp file/dir this suite actually used.
  rmSync(TMP_DIR, { recursive: true, force: true });
});

function runRoutinesTool(args, env = {}) {
  const nodeEnv = { ...process.env, AGENT_ROUTINE_OVERRIDES_PATH: OVERRIDES_PATH, ...env };
  return execFileSync('node', [ROUTINES_JS, ...args], {
    encoding: 'utf8',
    env: nodeEnv,
  });
}

function runHook(payload, sessionId = null, env = {}) {
  // Pass session_id in the JSON payload, as hooks receive it on stdin
  const payloadWithSession = sessionId
    ? { ...payload, session_id: sessionId }
    : payload;
  const nodeEnv = { ...process.env, AGENT_ROUTINE_OVERRIDES_PATH: OVERRIDES_PATH, ...env };
  return execFileSync('node', [HOOK], {
    input: JSON.stringify(payloadWithSession),
    encoding: 'utf8',
    env: nodeEnv,
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
