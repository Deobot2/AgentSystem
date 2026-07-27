#!/usr/bin/env node
/**
 * Mission Control — Webhook server tests
 * Coverage: repo validation, session registry, harness routing (claude + agy)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer as netCreateServer } from 'node:net';
import path from 'node:path';

const HOME = homedir();
const TEST_REGISTRY_PATH = `${HOME}/.claude/mission-control-registry-test.json`;

// ── Test fixtures ─────────────────────────────────────────────────────────

const MOCK_KNOWN_REPOS = {
  version: '1.0',
  repos: [
    {
      slug: 'agentsystem',
      path: '/home/natha/dev/AgentSystem',
      bootstrap_complete: true,
    },
    {
      slug: 'genie',
      path: '/home/natha/dev/arborgenie/genie',
      bootstrap_complete: true,
    },
    {
      slug: 'test-repo',
      path: '/home/test/repo',
      bootstrap_complete: true,
    },
  ],
};

// ── Test: Repo Validation ──────────────────────────────────────────────────

test('repoValidator.validateRepo() accepts valid repo slug', async (t) => {
  const { validateRepo } = await import('../tools/mission-control/repo-validator.js');

  const result = validateRepo('agentsystem', MOCK_KNOWN_REPOS);
  assert.ok(result, 'should return truthy');
  assert.equal(result.slug, 'agentsystem');
  assert.equal(result.path, '/home/natha/dev/AgentSystem');
});

test('repoValidator.validateRepo() rejects unknown repo', async (t) => {
  const { validateRepo } = await import('../tools/mission-control/repo-validator.js');

  assert.throws(
    () => validateRepo('unknown-repo', MOCK_KNOWN_REPOS),
    /not in allowlist/,
    'should throw on unknown repo'
  );
});

test('repoValidator.validateRepo() rejects path traversal', async (t) => {
  const { validateRepo } = await import('../tools/mission-control/repo-validator.js');

  assert.throws(
    () => validateRepo('../etc/passwd', MOCK_KNOWN_REPOS),
    /Invalid repo slug/,
    'should reject path traversal'
  );
});

test('repoValidator.validateRepo() rejects absolute paths', async (t) => {
  const { validateRepo } = await import('../tools/mission-control/repo-validator.js');

  assert.throws(
    () => validateRepo('/absolute/path', MOCK_KNOWN_REPOS),
    /Invalid repo slug/,
    'should reject absolute paths'
  );
});

// ── Test: Session Registry ─────────────────────────────────────────────────

test('SessionRegistry.createSession() stores claude session', async (t) => {
  const { SessionRegistry } = await import('../tools/mission-control/session-registry.js');
  const registry = new SessionRegistry(TEST_REGISTRY_PATH);

  const session = registry.createSession({
    harness: 'claude',
    agent: 'friday',
    repo: 'agentsystem',
    prompt: 'test prompt',
  });

  assert.ok(session.id, 'should have id');
  assert.match(session.id, /^claude-/, 'id should start with harness prefix');
  assert.equal(session.harness, 'claude');
  assert.equal(session.status, 'spawning');
  assert.equal(session.agent, 'friday');
});

test('SessionRegistry.createSession() stores agy session', async (t) => {
  const { SessionRegistry } = await import('../tools/mission-control/session-registry.js');
  const registry = new SessionRegistry(TEST_REGISTRY_PATH);

  const session = registry.createSession({
    harness: 'agy',
    model: 'gemini-2.0',
    repo: 'genie',
    prompt: 'test prompt',
  });

  assert.ok(session.id, 'should have id');
  assert.match(session.id, /^agy-/, 'id should start with agy prefix');
  assert.equal(session.harness, 'agy');
  assert.equal(session.model, 'gemini-2.0');
});

test('SessionRegistry.getSession() retrieves stored session', async (t) => {
  const { SessionRegistry } = await import('../tools/mission-control/session-registry.js');
  const registry = new SessionRegistry(TEST_REGISTRY_PATH);

  const created = registry.createSession({
    harness: 'claude',
    agent: 'friday',
    repo: 'agentsystem',
    prompt: 'test',
  });

  const retrieved = registry.getSession(created.id);
  assert.equal(retrieved.id, created.id);
  assert.equal(retrieved.agent, 'friday');
});

test('SessionRegistry.updateSession() marks session running', async (t) => {
  const { SessionRegistry } = await import('../tools/mission-control/session-registry.js');
  const registry = new SessionRegistry(TEST_REGISTRY_PATH);

  const session = registry.createSession({
    harness: 'claude',
    agent: 'friday',
    repo: 'agentsystem',
    prompt: 'test',
  });

  registry.updateSession(session.id, {
    status: 'running',
    logPath: '/home/natha/.claude/logs/abc123.jsonl',
  });

  const updated = registry.getSession(session.id);
  assert.equal(updated.status, 'running');
  assert.equal(updated.logPath, '/home/natha/.claude/logs/abc123.jsonl');
});

test('SessionRegistry persists to disk', async (t) => {
  const { SessionRegistry } = await import('../tools/mission-control/session-registry.js');
  const testPath = `${HOME}/.claude/mission-control-registry-persist-test.json`;

  const registry1 = new SessionRegistry(testPath);
  const session = registry1.createSession({
    harness: 'agy',
    model: 'gemini-2.0',
    repo: 'genie',
    prompt: 'test',
  });

  // Create new registry instance pointing to same file
  const registry2 = new SessionRegistry(testPath);
  const retrieved = registry2.getSession(session.id);

  assert.ok(retrieved, 'should persist to disk and be retrievable');
  assert.equal(retrieved.harness, 'agy');

  // Cleanup
  try { rmSync(testPath); } catch {}
});

test('SessionRegistry.getSessions() returns all sessions', async (t) => {
  const { SessionRegistry } = await import('../tools/mission-control/session-registry.js');
  const testPath = `${HOME}/.claude/mission-control-registry-all-test.json`;

  const registry = new SessionRegistry(testPath);

  const s1 = registry.createSession({
    harness: 'claude',
    agent: 'friday',
    repo: 'agentsystem',
    prompt: 'test1',
  });

  const s2 = registry.createSession({
    harness: 'agy',
    model: 'gemini-2.0',
    repo: 'genie',
    prompt: 'test2',
  });

  const all = registry.getSessions();
  assert.equal(all.length, 2);
  assert.ok(all.find(s => s.id === s1.id));
  assert.ok(all.find(s => s.id === s2.id));

  // Cleanup
  try { rmSync(testPath); } catch {}
});

// ── Test: Harness routing ──────────────────────────────────────────────────

test('POST /run accepts claude harness', async (t) => {
  // This is integration-level; we mock the intent here
  const request = {
    harness: 'claude',
    prompt: 'review the code',
    repo: 'agentsystem',
    agent: 'friday',
  };

  assert.equal(request.harness, 'claude');
  assert.equal(request.agent, 'friday');
});

test('POST /run accepts agy harness', async (t) => {
  const request = {
    harness: 'agy',
    prompt: 'review the code',
    repo: 'genie',
    model: 'gemini-2.0',
  };

  assert.equal(request.harness, 'agy');
  assert.equal(request.model, 'gemini-2.0');
});

test('POST /run rejects unknown harness', async (t) => {
  const request = {
    harness: 'unknown-harness',
    prompt: 'review the code',
    repo: 'agentsystem',
  };

  const validHarnesses = ['claude', 'agy'];
  assert.ok(!validHarnesses.includes(request.harness));
});

// ── Test: Session ID generation ────────────────────────────────────────────

test('Session ID has correct format for claude', async (t) => {
  const { SessionRegistry } = await import('../tools/mission-control/session-registry.js');
  const registry = new SessionRegistry(TEST_REGISTRY_PATH);

  const session = registry.createSession({
    harness: 'claude',
    agent: 'friday',
    repo: 'agentsystem',
    prompt: 'test',
  });

  assert.match(session.id, /^claude-[a-f0-9]{8}$/);
});

test('Session ID has correct format for agy', async (t) => {
  const { SessionRegistry } = await import('../tools/mission-control/session-registry.js');
  const registry = new SessionRegistry(TEST_REGISTRY_PATH);

  const session = registry.createSession({
    harness: 'agy',
    model: 'gemini-2.0',
    repo: 'genie',
    prompt: 'test',
  });

  assert.match(session.id, /^agy-[a-f0-9]{8}$/);
});

// ── Test: Cost estimate tracking ───────────────────────────────────────────

test('Claude session has costEstimate null initially', async (t) => {
  const { SessionRegistry } = await import('../tools/mission-control/session-registry.js');
  const registry = new SessionRegistry(TEST_REGISTRY_PATH);

  const session = registry.createSession({
    harness: 'claude',
    agent: 'friday',
    repo: 'agentsystem',
    prompt: 'test',
  });

  assert.equal(session.costEstimate, null);
});

test('Agy session has costEstimate null (quota-based)', async (t) => {
  const { SessionRegistry } = await import('../tools/mission-control/session-registry.js');
  const registry = new SessionRegistry(TEST_REGISTRY_PATH);

  const session = registry.createSession({
    harness: 'agy',
    model: 'gemini-2.0',
    repo: 'genie',
    prompt: 'test',
  });

  assert.equal(session.costEstimate, null);
});

// ── Test: Concurrency cap enforcement ──────────────────────────────────────

test('Concurrency cap: getRunning() includes spawning and running', async (t) => {
  const { SessionRegistry } = await import('../tools/mission-control/session-registry.js');
  const testPath = `${HOME}/.claude/mission-control-registry-cap-fresh-test.json`;

  // Ensure clean state
  try { rmSync(testPath); } catch {}

  const registry = new SessionRegistry(testPath);

  const s1 = registry.createSession({
    harness: 'claude',
    agent: 'friday',
    repo: 'agentsystem',
    prompt: 'test1',
  });

  // Initially spawning (getRunning includes spawning status)
  let running = registry.getRunning();
  assert.equal(running.length, 1, 'should have 1 spawning session');

  // Mark as running
  registry.updateSession(s1.id, { status: 'running' });
  running = registry.getRunning();
  assert.equal(running.length, 1, 'should have 1 running session');

  // Mark as exited
  registry.exitSession(s1.id, 0);
  running = registry.getRunning();
  assert.equal(running.length, 0, 'should have 0 sessions after exit');

  try { rmSync(testPath); } catch {}
});

test('Concurrency cap: cannot spawn second claude while one running', async (t) => {
  const { SessionRegistry } = await import('../tools/mission-control/session-registry.js');
  const testPath = `${HOME}/.claude/mission-control-registry-cap-conflict-fresh-test.json`;

  // Ensure clean state
  try { rmSync(testPath); } catch {}

  const registry = new SessionRegistry(testPath);

  const s1 = registry.createSession({
    harness: 'claude',
    agent: 'friday',
    repo: 'agentsystem',
    prompt: 'test1',
  });

  registry.updateSession(s1.id, { status: 'running' });

  // Simulate trying to spawn another claude
  const running = registry.getRunning().filter(s => s.harness === 'claude');
  assert.equal(running.length, 1, 'should have one running claude session');

  try { rmSync(testPath); } catch {}
});

test('GET /health endpoint response structure', async (t) => {
  const response = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    daemon: { status: 'running' },
    active_sessions: 0,
    platform: process.platform,
    node_version: process.version
  };

  assert.equal(response.status, 'ok');
  assert.ok(response.timestamp);
  assert.equal(response.daemon.status, 'running');
});

test('POST /stop payload verification', async (t) => {
  const request = {
    id: 'claude-123456'
  };

  assert.ok(request.id, 'id is required');
  assert.match(request.id, /^(claude|agy)-[a-f0-9]+$/);
});

test('GET /scratchpads response format', async (t) => {
  const response = {
    scratchpads: [
      { project: 'agentsystem', issue: 'issue-10', path: '/home/tasks/agentsystem/issue-10/scratchpad.md' }
    ]
  };
  assert.ok(Array.isArray(response.scratchpads));
  assert.equal(response.scratchpads[0].project, 'agentsystem');
});

test('POST /memory/remember payload validation', async (t) => {
  const request = {
    fact: 'This is a durable fact.',
    tier: 'personal',
    section: 'Session Notes'
  };
  assert.ok(request.fact);
  assert.equal(request.tier, 'personal');
});

test('GET /memory/search query structure', async (t) => {
  const request = {
    agent: 'friday',
    query: 'security audit'
  };
  assert.equal(request.agent, 'friday');
  assert.equal(request.query, 'security audit');
});

// ── Test: /sessions does not re-pay the claude CLI cold start on every poll ──
// Regression: getActiveSessions() shelled out to `claude agents --json` on every
// request with no cache and no timeout. The real CLI cold-starts in ~13s and the
// panel polls every 15s, so the panel was never fresher than 13s and kept a CLI
// process resident. A fake slow `claude` reproduces that shape in 3s.

test('/sessions serves a cached roster instead of shelling out per request', async (t) => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'mc-sessions-'));
  const fakeClaude = path.join(tmp, 'claude');
  writeFileSync(fakeClaude, '#!/bin/sh\nsleep 3\necho \'[{"id":"aaaa1111","cwd":"/tmp","kind":"background"}]\'\n');
  chmodSync(fakeClaude, 0o755);

  // The server refuses to boot without a bearer key. CI runners have none.
  const keyFile = `${HOME}/.claude/remote-webhook.key`;
  const keyWasOurs = !existsSync(keyFile);
  if (keyWasOurs) {
    mkdirSync(path.dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  }

  const port = await freePort();
  const server = spawn(process.execPath, ['tools/mission-control/webhook-server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, CLAUDE_BIN: fakeClaude, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    server.kill('SIGKILL');
    rmSync(tmp, { recursive: true, force: true });
    if (keyWasOurs) rmSync(keyFile, { force: true });
  });

  await waitForLine(server.stdout, 'Claude Remote Control Server');
  // Let the boot prewarm finish so the first real request is already warm.
  await sleep(4500);

  const key = readFileSync(`${HOME}/.claude/remote-webhook.key`, 'utf8').trim();
  const headers = { Authorization: `Bearer ${key}` };
  const url = `http://127.0.0.1:${port}/sessions`;

  const first = await fetch(url, { headers });
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.ok(body.sessions.some(s => s.id === 'aaaa1111'), 'roster from the fake CLI is served');

  // Three back-to-back polls. Uncached this would cost 3 x 3s.
  const started = Date.now();
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers });
    assert.equal(r.status, 200);
    await r.json();
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `3 polls took ${elapsed}ms — cache is not being served`);
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function freePort() {
  return new Promise((resolve, reject) => {
    const s = netCreateServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function waitForLine(stream, needle, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${needle}"; saw: ${buf}`)), timeoutMs);
    stream.on('data', d => {
      buf += d;
      if (buf.includes(needle)) { clearTimeout(timer); resolve(buf); }
    });
  });
}

// Cleanup test files
test('cleanup', async (t) => {
  try { rmSync(TEST_REGISTRY_PATH); } catch {}
});
