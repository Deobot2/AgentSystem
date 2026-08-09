#!/usr/bin/env node
// continuous-sync-hook.js — SessionStart/SessionEnd half of continuous sync (#341).
//
// The constraint that shapes this file: SessionStart must not block on the network. `git fetch`
// against two remotes on a cold link is seconds, and the hook's registered timeout is 5. So the
// hook is two-phase like session-auto-rename-hook.js — spawn a detached worker, print OK, exit —
// and the tests check the fast path returns immediately while the worker does the real calls.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOOK = path.join(__dirname, 'continuous-sync-hook.js');
const { workerPlan, PHASES, CHILD_ENV_GUARD } = require('./continuous-sync-hook.js');

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'continuous-sync-'));

/** A fake tools dir whose scripts record their argv instead of touching git. */
function fakeTools(dir, { exitCode = 0 } = {}) {
  const tools = path.join(dir, 'tools');
  fs.mkdirSync(tools, { recursive: true });
  for (const name of ['brain-sync-run.js', 'repo-sync.js']) {
    fs.writeFileSync(path.join(tools, name), `
      require('fs').appendFileSync(${JSON.stringify(path.join(dir, 'calls.log'))},
        JSON.stringify([${JSON.stringify(name)}, ...process.argv.slice(2)]) + '\\n');
      process.exit(${exitCode});
    `);
  }
  return tools;
}

const calls = (dir) => {
  const f = path.join(dir, 'calls.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse) : [];
};

function runHook(args, { dir, input = '{"session_id":"abc123","cwd":"/tmp"}', env = {} } = {}) {
  return spawnSync(process.execPath, [HOOK, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, AGENT_TOOLS_ROOT: dir ? fakeTools(dir) : '', CONTINUOUS_SYNC_LOG: dir ? path.join(dir, 'sync.log') : '', ...env },
  });
}

// ── the plan ──────────────────────────────────────────────────────────────────

test('SessionStart pulls memory then pulls code — in that order', () => {
  const plan = workerPlan('start', '/t');
  assert.deepEqual(plan.map((s) => path.basename(s.script)), ['brain-sync-run.js', 'repo-sync.js']);
  assert.deepEqual(plan[0].args, ['--pull-only'], 'session start must not push');
});

test('SessionEnd commits and pushes memory, and never touches code', () => {
  const plan = workerPlan('end', '/t');
  assert.deepEqual(plan.map((s) => path.basename(s.script)), ['brain-sync-run.js']);
  assert.deepEqual(plan[0].args, [], 'session end is the push half');
  // Pulling code out from under anything at session end is how you rewrite a tree someone is
  // still using. Code sync is SessionStart-only, on purpose.
  assert.equal(plan.some((s) => s.script.includes('repo-sync')), false);
});

test('an unknown phase plans nothing rather than guessing', () => {
  assert.deepEqual(workerPlan('midway', '/t'), []);
  assert.deepEqual(PHASES.slice().sort(), ['end', 'start']);
});

// ── fast path ─────────────────────────────────────────────────────────────────

test('the hook returns immediately and does no git work itself', () => {
  const dir = scratch();
  const started = Date.now();
  const r = runHook(['--phase=start'], { dir });
  const elapsed = Date.now() - started;

  assert.equal(r.status, 0);
  assert.ok(elapsed < 3000, `fast path took ${elapsed}ms — it is supposed to hand off and exit`);
});

// SessionStart stdout is injected into the session as context. Anything printed here is prepended
// to every session on this machine for as long as the hook is installed, so the bar is not "is it
// short" — it is that a sync nobody asked about contributes nothing to the conversation.
test('the hook prints nothing — its stdout would be injected into every session', () => {
  const dir = scratch();
  for (const phase of ['start', 'end']) {
    const r = runHook([`--phase=${phase}`], { dir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', `${phase} phase wrote to stdout: ${JSON.stringify(r.stdout)}`);
  }
});

test('a malformed or empty payload never fails the session', () => {
  const dir = scratch();
  const r = runHook(['--phase=start'], { dir, input: 'not json at all' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('the hook is inert inside its own child process', () => {
  const dir = scratch();
  const r = runHook(['--worker', '--phase=start'], { dir, env: { [CHILD_ENV_GUARD]: '1' } });
  assert.equal(r.status, 0);
  assert.deepEqual(calls(dir), [], 'recursed into itself');
});

// ── worker ────────────────────────────────────────────────────────────────────

test('the start worker runs both syncs with the right arguments', () => {
  const dir = scratch();
  const r = runHook(['--worker', '--phase=start'], { dir });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(dir), [['brain-sync-run.js', '--pull-only'], ['repo-sync.js']]);
});

test('the end worker syncs memory only', () => {
  const dir = scratch();
  runHook(['--worker', '--phase=end'], { dir });
  assert.deepEqual(calls(dir), [['brain-sync-run.js']]);
});

test('a failing memory sync does not stop the code pull, and the worker still exits 0', () => {
  const dir = scratch();
  const tools = fakeTools(dir);
  fs.writeFileSync(path.join(tools, 'brain-sync-run.js'), `
    require('fs').appendFileSync(${JSON.stringify(path.join(dir, 'calls.log'))}, JSON.stringify(['brain-sync-run.js', ...process.argv.slice(2)]) + '\\n');
    process.exit(3);
  `);
  const r = spawnSync(process.execPath, [HOOK, '--worker', '--phase=start'], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_TOOLS_ROOT: tools, CONTINUOUS_SYNC_LOG: path.join(dir, 'sync.log') },
  });
  assert.equal(r.status, 0, 'a sync problem must never be reported as a hook crash');
  assert.deepEqual(calls(dir).map((c) => c[0]), ['brain-sync-run.js', 'repo-sync.js']);
});

test('the worker records what it did, so an unattended host is diagnosable', () => {
  const dir = scratch();
  runHook(['--worker', '--phase=end'], { dir });
  const log = path.join(dir, 'sync.log');
  assert.ok(fs.existsSync(log), 'no log written');
  assert.match(fs.readFileSync(log, 'utf8'), /brain-sync-run/);
});

test('a missing tools dir is survived silently', () => {
  const r = spawnSync(process.execPath, [HOOK, '--worker', '--phase=start'], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_TOOLS_ROOT: path.join(os.tmpdir(), 'definitely-not-here-341') },
  });
  assert.equal(r.status, 0);
});
