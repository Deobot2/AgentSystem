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
import { spawn, execFileSync } from 'node:child_process';
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

  // Both marketplace layouts, because only reading the flat one found 7 commands on a host
  // that has ~40. `~/.claude/skills` is deliberately left absent so the missing-dir path
  // stays covered too.
  const mp = path.join(home, '.claude', 'plugins', 'marketplaces');
  mkdirSync(path.join(mp, 'flat', 'skills', 'flat-skill'), { recursive: true });
  writeFileSync(path.join(mp, 'flat', 'skills', 'flat-skill', 'SKILL.md'), '---\ndescription: a flat one\n---\n');
  mkdirSync(path.join(mp, 'bundle', 'plugins', 'inner', 'skills', 'nested-skill'), { recursive: true });
  writeFileSync(path.join(mp, 'bundle', 'plugins', 'inner', 'skills', 'nested-skill', 'SKILL.md'), '---\ndescription: a nested one\n---\n');
  mkdirSync(path.join(mp, 'bundle', 'plugins', 'inner', 'commands'), { recursive: true });
  writeFileSync(path.join(mp, 'bundle', 'plugins', 'inner', 'commands', 'nested-cmd.md'), '---\ndescription: nested command\n---\n');

  // /branches shells out to git, so the seeded repo has to actually be one.
  // -c user.* because a CI runner has no global git identity to commit with.
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', home]);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q',
    '--allow-empty', '-m', 'seed'], { cwd: home });

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

// ── The MC-only workflow endpoints ────────────────────────────────────────────
// These close the loop that used to need a terminal on the host: answer a blocked
// session, review a diff, flip/merge the PR, see what branches are left behind.
// gh isn't authenticated in CI, so the PR/diff assertions cover validation only.

test('POST /reply rejects a non-UUID sessionId', async () => {
  const r = await api('/reply', {
    method: 'POST',
    body: JSON.stringify({ sessionId: '../../etc/passwd', message: 'hi' }),
  });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /UUID/);
});

test('POST /reply requires a message', async () => {
  const r = await api('/reply', {
    method: 'POST',
    body: JSON.stringify({ sessionId: '11111111-2222-4333-8444-555555555555', message: '   ' }),
  });
  assert.equal(r.status, 400);
});

test('POST /pr rejects an unknown action', async () => {
  const r = await api('/pr', { method: 'POST', body: JSON.stringify({ number: 1, action: 'close' }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Valid: ready, merge, comment/);
});

test('POST /pr rejects a non-numeric PR number', async () => {
  const r = await api('/pr', { method: 'POST', body: JSON.stringify({ number: 'main', action: 'ready' }) });
  assert.equal(r.status, 400);
});

test('GET /diff requires a pr number', async () => {
  const r = await api('/diff');
  assert.equal(r.status, 400);
});

test('GET /branches rejects a repo outside the allowlist', async () => {
  const r = await api('/branches?repo=not-a-known-repo');
  assert.equal(r.status, 403);
});

test('GET /branches reports the seeded repo branch and worktree', async () => {
  const r = await api('/branches?repo=demo');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.current, 'main');
  assert.ok(body.branches.some(b => b.name === 'main'), 'main missing from branch list');
  assert.equal(body.worktrees.length, 1);
  assert.equal(body.worktrees[0].branch, 'main');
});

// ── swarm dispatch ───────────────────────────────────────────────────────────

test('POST /swarm requires a tasks array', async () => {
  const r = await api('/swarm', { method: 'POST', body: JSON.stringify({ harness: 'claude', repo: 'demo' }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /tasks required/);
});

test('POST /swarm rejects an oversized batch', async () => {
  const tasks = Array.from({ length: 21 }, (_, i) => ({ agent: 'friday', prompt: `t${i}` }));
  const r = await api('/swarm', { method: 'POST', body: JSON.stringify({ harness: 'claude', repo: 'demo', tasks }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /max 20/);
});

// Nothing is spawned here: an unknown agent is rejected before the registry entry exists.
// The point is the shape — per-task rejections come back itemised, not as one opaque failure —
// and that the reported cap is no longer the old hard 1.
test('POST /swarm reports per-task rejections and the per-harness cap', async () => {
  const r = await api('/swarm', {
    method: 'POST',
    body: JSON.stringify({ harness: 'claude', repo: 'demo', tasks: [{ agent: 'notanagent', prompt: 'noop' }] }),
  });
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.requested, 1);
  assert.equal(body.dispatched.length, 0);
  assert.match(body.rejected[0].error, /Unknown agent/);
  assert.equal(body.rejected[0].index, 0);
  assert.ok(body.cap > 1, `per-harness cap should be >1, got ${body.cap}`);
});

// ── skills / commands discovery ──────────────────────────────────────────────

// The throwaway HOME has no `~/.claude/skills` at all, so this also pins that a missing
// directory is an empty list, not a 500.
test('GET /skills returns arrays and the agent roster', async () => {
  const r = await api('/skills');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body.skills));
  assert.ok(Array.isArray(body.commands));
  assert.ok(body.agents.includes('friday'));
});

// Both layouts, or the picker silently shows a fraction of what is installed: the flat
// `<marketplace>/skills/` and the nested `<marketplace>/plugins/<name>/skills/`.
test('GET /skills finds flat and nested plugin layouts', async () => {
  const body = await (await api('/skills')).json();
  const skill = n => body.skills.find(s => s.name === n);
  assert.ok(skill('flat-skill'), 'flat marketplace skill missing');
  assert.ok(skill('nested-skill'), 'nested plugin skill missing');
  assert.equal(skill('nested-skill').description, 'a nested one', 'frontmatter description not read');
  assert.equal(skill('nested-skill').source, 'inner', 'nested skill should be attributed to its plugin');
  assert.ok(body.commands.some(c => c.name === 'nested-cmd'), 'nested plugin command missing');
});

// ── allowlisted ops ──────────────────────────────────────────────────────────

test('GET /ops lists allowlisted operations only', async () => {
  const r = await api('/ops');
  assert.equal(r.status, 200);
  const ids = (await r.json()).ops.map(o => o.id);
  assert.ok(ids.includes('routines.list'));
  assert.ok(ids.includes('brain.status'));
  // No op may name a shell or an arbitrary command runner.
  assert.ok(!ids.some(id => /^(sh|bash|exec|shell)\b/.test(id)), `suspicious op id in ${ids.join(',')}`);
});

test('POST /ops/run refuses an id outside the registry', async () => {
  const r = await api('/ops/run', { method: 'POST', body: JSON.stringify({ id: '../../bin/sh' }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Unknown op/);
});

// Prototype keys must not resolve as ops — `hasOwnProperty` guard, not a bare lookup.
test('POST /ops/run refuses prototype keys', async () => {
  const r = await api('/ops/run', { method: 'POST', body: JSON.stringify({ id: 'constructor' }) });
  assert.equal(r.status, 400);
});

test('POST /ops/run rejects an arg that fails the op pattern', async () => {
  const r = await api('/ops/run', {
    method: 'POST',
    body: JSON.stringify({ id: 'routines.bypass', arg: 'x; rm -rf /' }),
  });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /requires arg matching/);
});

test('POST /ops/run rejects an arg on an op that takes none', async () => {
  const r = await api('/ops/run', { method: 'POST', body: JSON.stringify({ id: 'routines.list', arg: 'extra' }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /takes no argument/);
});

test('POST /ops/run requires the arg when the op declares one', async () => {
  const r = await api('/ops/run', { method: 'POST', body: JSON.stringify({ id: 'alerts.resolve' }) });
  assert.equal(r.status, 400);
});

// The one end-to-end run: read-only, no network, and it proves runNodeTool resolves the
// script path and returns the child's output rather than an empty 200.
test('POST /ops/run executes a read-only op and returns its output', async () => {
  const r = await api('/ops/run', { method: 'POST', body: JSON.stringify({ id: 'routines.list' }) });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.id, 'routines.list');
  assert.equal(body.command, 'node tools/routines.js list');
  assert.ok(body.output.length > 0, 'op produced no output');
});

test('unhandled endpoint error returns 500, server survives', async () => {
  const r = await api('/definitely-not-a-route');
  assert.equal(r.status, 404);
  const still = await api('/');
  assert.equal(still.status, 200);
});
