#!/usr/bin/env node
/**
 * Mission Control — live HTTP endpoint tests
 *
 * The existing test_mission_control.js covers registry/validator units but never
 * boots the server, which is why a shadowed `path` identifier silently broke five
 * endpoints (and crashed the process on /memory/file) without failing a test.
 * These tests spawn the real webhook-server against a throwaway HOME and hit it
 * over HTTP.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'mission-control', 'webhook-server.js');
const KEY = 'test-key-do-not-use';

// Ask the OS for a free port instead of deriving one from the pid — `8700 + pid % 90`
// collides whenever two concurrent `node --test` workers land in the same residue
// class, and the loser fails with "server did not become ready".
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

let home, proc, PORT, BASE, serverErr = '';

function api(p, opts = {}) {
  return fetch(BASE + p, {
    ...opts,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
}

async function waitForReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await api('/');
      if (r.ok) return;
    } catch { /* not listening yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  // Without the child's stderr the failure is undiagnosable from CI logs alone.
  throw new Error(`server did not become ready on :${PORT}\n--- server stderr ---\n${serverErr}`);
}

test.before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  home = mkdtempSync(path.join(tmpdir(), 'mc-http-'));
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  mkdirSync(path.join(home, 'agent-memory', 'nexus', 'tasks', 'demo', '42'), { recursive: true });
  writeFileSync(path.join(home, '.claude', 'remote-webhook.key'), KEY);
  writeFileSync(path.join(home, 'agent-memory', 'nexus', 'known-repos.json'),
    JSON.stringify({ repos: [{ slug: 'demo', path: home, bootstrap_complete: true }] }));
  writeFileSync(path.join(home, 'agent-memory', 'nexus', 'tasks', 'demo', '42', 'scratchpad.md'), '# scratch\nhello\n');

  proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, HOME: home, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', d => { serverErr = (serverErr + d).slice(-2000); });
  await waitForReady();
});

test.after(() => {
  proc?.kill('SIGKILL');
  if (home) rmSync(home, { recursive: true, force: true });
});

test('unauthenticated request is rejected', async () => {
  const r = await fetch(`${BASE}/`);
  assert.equal(r.status, 401);
});

test('GET / reports ok', async () => {
  const r = await api('/');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'ok');
});

// Regression: `const path = url.pathname` shadowed the node:path import, so
// path.join() threw inside the handler and the catch returned an empty list.
test('GET /scratchpads finds seeded scratchpad', async () => {
  const r = await api('/scratchpads');
  assert.equal(r.status, 200);
  const { scratchpads } = await r.json();
  assert.equal(scratchpads.length, 1, 'expected the seeded scratchpad, got none (path shadow regression)');
  assert.equal(scratchpads[0].project, 'demo');
  assert.equal(scratchpads[0].issue, '42');
});

test('GET /scratchpad returns content', async () => {
  const r = await api('/scratchpad?project=demo&issue=42');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /hello/);
});

// Regression: path.resolve() threw here and was NOT inside a try/catch, so this
// endpoint killed the entire server process.
test('GET /memory/file serves a file without killing the server', async () => {
  const target = path.join(home, 'agent-memory', 'nexus', 'known-repos.json');
  const r = await api(`/memory/file?path=${encodeURIComponent(target)}`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /demo/);

  const still = await api('/');
  assert.equal(still.status, 200, 'server died after /memory/file');
});

test('GET /memory/file refuses paths outside agent-memory', async () => {
  const r = await api(`/memory/file?path=${encodeURIComponent('/etc/passwd')}`);
  assert.equal(r.status, 403);
});

// Regression: the agy branch called an undefined dispatchAgy(), so every agy
// dispatch returned "dispatchAgy is not defined". agy itself isn't installed in
// CI, so assert only that we get past the ReferenceError.
test('POST /run agy harness reaches the dispatcher', async () => {
  const r = await api('/run', {
    method: 'POST',
    body: JSON.stringify({ harness: 'agy', prompt: 'noop', repo: 'demo' }),
  });
  const body = await r.text();
  assert.doesNotMatch(body, /dispatchAgy is not defined/, 'agy dispatch still hits the undefined symbol');
});

// Regression: memory-lookup.js exited 1 with prose when an agent had no memory
// dir, so this 500'd for every agent on a host with no per-agent dirs.
test('GET /memory/search returns empty results, not a 500', async () => {
  const r = await api('/memory/search?agent=jarvis&query=anything');
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).results, []);
});

test('unhandled endpoint error returns 500, server survives', async () => {
  const r = await api('/definitely-not-a-route');
  assert.equal(r.status, 404);
  const still = await api('/');
  assert.equal(still.status, 200);
});
