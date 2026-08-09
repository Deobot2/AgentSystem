#!/usr/bin/env node
// brain-sync-run.js — the supervised wrapper that hooks and the host timer actually call (#341).
//
// brain-sync.js already syncs correctly and is not re-tested here. What is tested is everything
// around it: the lock that keeps a 15-minute timer from racing a SessionEnd hook, the exit-code
// translation, and the one rule that must never bend — a conflict raises a human-needed alert and
// is NEVER auto-resolved. `~/agent-memory` is user data in a private repo; `-X ours` there is data
// loss with a green exit code.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { classify, raiseArgs, conflictedFiles, alertKey, cacheDir, ALERT_KEY } from './brain-sync-run.js';

const KEY = alertKey();

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'brain-sync-run.js');

/**
 * A stand-in for brain-sync.js / human-needed.js that records its argv and exits with `code`.
 * Recording argv is the point: it is how we prove no conflict-resolution flag is ever forwarded.
 */
function recorder(dir, name, code, stderr = null) {
  const script = join(dir, `${name}.cjs`);
  const log = join(dir, `${name}.log`);
  // What it says on stderr matters as much as the code: the wrapper distinguishes "brain-sync said
  // a human must merge" from "some git command failed" by the message, not by exit 1 alone.
  const says = stderr !== null ? stderr
    : (code === 1 ? 'brain-sync: merge conflict needs a human:\n  nodes/x.md\n' : '');
  rmSync(log, { force: true }); // per-run call log; alert state is what persists between runs
  writeFileSync(script, `
    const fs = require('fs');
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
    process.stderr.write(${JSON.stringify(says)});
    process.exit(${code});
  `);
  return { script, log, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []) };
}

function run(dir, { brainSyncExit = 0, brainSyncStderr = null, humanNeededExit = 0, extra = [] } = {}) {
  const brain = recorder(dir, 'fake-brain-sync', brainSyncExit, brainSyncStderr);
  const human = recorder(dir, 'fake-human-needed', humanNeededExit);
  const r = spawnSync(process.execPath, [
    SCRIPT,
    '--path', dir,
    '--lock', join(dir, 'run.lock'),
    '--state', join(dir, 'alert.state'),
    '--brain-sync', brain.script,
    '--human-needed', human.script,
    ...extra,
  ], { encoding: 'utf8' });
  return { ...r, brain, human };
}

const scratch = () => mkdtempSync(join(tmpdir(), 'brain-sync-run-'));

// ── exit-code translation ─────────────────────────────────────────────────────

const CONFLICT = 'brain-sync: merge conflict needs a human:\n  nodes/x.md\n';

test('classify maps brain-sync exit codes to runner outcomes', () => {
  assert.equal(classify(0).outcome, 'ok');
  assert.equal(classify(1, CONFLICT).outcome, 'conflict');
  assert.equal(classify(2).outcome, 'setup');
  assert.equal(classify(137).outcome, 'error');
});

test('classify: only a conflict is worth waking a human', () => {
  assert.equal(classify(1, CONFLICT).alert, true);
  assert.equal(classify(0).alert, false);
  assert.equal(classify(2).alert, false);
});

// The one that matters: brain-sync die()s with exit 1 on ANY failed git command, so a bare 1 is far
// more often an offline fetch or expired credentials than a merge conflict. Calling those conflicts
// is wrong twice over — it opens a "resolve this merge by hand" issue about a network blip, and it
// returns 3, which the systemd unit declares a success. A host failing to sync every 15 minutes
// would report healthy.
test('classify: exit 1 without the conflict message is a plain failure, not a conflict', () => {
  const offline = classify(1, 'brain-sync: git fetch --quiet origin failed (128)\nCould not resolve host: github.com\n');
  assert.equal(offline.outcome, 'error');
  assert.equal(offline.alert, false, 'raised a merge-conflict alert about a failed fetch');
  assert.equal(offline.exit, 2, 'exit 3 is declared a success by the unit — a broken sync must not use it');

  const noStderr = classify(1);
  assert.equal(noStderr.alert, false);
  assert.equal(noStderr.exit, 2);
});

// Per host, because the blocked working tree is per host. Under one global key the laptop finishing
// its merge closes the issue while the Mission Control box is still stuck behind its own.
test('the alert key is scoped to the host', () => {
  assert.equal(alertKey('mission-control'), 'brain-sync-conflict-mission-control');
  assert.equal(alertKey('WIN-Laptop_01'), 'brain-sync-conflict-win-laptop-01');
  assert.notEqual(alertKey('a'), alertKey('b'));
  assert.match(alertKey('a'), new RegExp(`^${ALERT_KEY}-`));
});

// State says "this host has an open issue" and is the only thing that ever closes it. tmpdir is
// cleared at boot on most hosts, which would strand the issue open forever.
test('alert state lives somewhere that survives a reboot', () => {
  assert.doesNotMatch(cacheDir(), new RegExp(tmpdir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(cacheDir(), /agentsystem$/);
});

test('raiseArgs builds a human-needed call with the stable key and no resolution advice', () => {
  const args = raiseArgs({ root: '/home/x/agent-memory', host: 'box', detail: 'nodes/x.md' });
  assert.equal(args[0], 'raise');
  assert.equal(args[1], alertKey('box'));
  const joined = args.join(' ');
  assert.match(joined, /box/);
  assert.match(joined, /agent-memory/);
  assert.doesNotMatch(joined, /-X (ours|theirs)/, 'never suggest a strategy that discards user data');
});

// ── end to end ────────────────────────────────────────────────────────────────

test('a clean sync exits 0 and raises nothing', () => {
  const dir = scratch();
  const r = run(dir, { brainSyncExit: 0 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.human.calls().length, 0, 'called human-needed on a clean sync');
});

test('brain-sync is invoked with the brain path and nothing that resolves conflicts', () => {
  const dir = scratch();
  const r = run(dir);
  const [argv] = r.brain.calls();
  assert.deepEqual(argv, ['--path', dir]);
});

test('--pull-only is forwarded', () => {
  const dir = scratch();
  const r = run(dir, { extra: ['--pull-only'] });
  assert.deepEqual(r.brain.calls()[0], ['--path', dir, '--pull-only']);
});

test('a conflict exits 3, raises the alert, and does not retry with a merge strategy', () => {
  const dir = scratch();
  const r = run(dir, { brainSyncExit: 1 });
  assert.equal(r.status, 3, `expected 3 (conflict, alert raised), got ${r.status}: ${r.stderr}`);

  const calls = r.human.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'raise');
  assert.equal(calls[0][1], KEY);

  // One brain-sync attempt. A second one would mean the wrapper tried to "help".
  assert.equal(r.brain.calls().length, 1);
  assert.equal(existsSync(join(dir, 'alert.state')), true, 'no alert state recorded');
});

test('a later clean sync resolves the alert exactly once', () => {
  const dir = scratch();
  run(dir, { brainSyncExit: 1 });

  const ok = run(dir, { brainSyncExit: 0 });
  assert.equal(ok.status, 0);
  const resolves = ok.human.calls().filter((c) => c[0] === 'resolve');
  assert.equal(resolves.length, 1);
  assert.equal(resolves[0][1], KEY);

  // Nothing left to resolve: the next clean run must not call gh again.
  const quiet = run(dir, { brainSyncExit: 0 });
  assert.equal(quiet.human.calls().length, 0, 'resolved an alert that was already resolved');
});

test('a setup error (exit 2) is passed through without alerting', () => {
  const dir = scratch();
  const r = run(dir, { brainSyncExit: 2 });
  assert.equal(r.status, 2);
  assert.equal(r.human.calls().length, 0);
});

test('a git failure from brain-sync is exit 2 and raises no conflict issue', () => {
  const dir = scratch();
  const r = run(dir, {
    brainSyncExit: 1,
    brainSyncStderr: 'brain-sync: git push --quiet origin main failed (128)\nCould not resolve host: github.com\n',
  });
  assert.equal(r.status, 2, 'exit 3 would tell systemd this failing sync succeeded');
  assert.equal(r.human.calls().length, 0, 'opened a merge-conflict issue about a network failure');
});

test('a held lock skips the run entirely and still exits 0', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'run.lock'), JSON.stringify({ pid: 1, host: 'other', at: new Date().toISOString() }));

  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.brain.calls().length, 0, 'ran git while another sync held the lock');
  assert.match(r.stdout, /lock/i);
});

test('the lock is released after a run, so the next one is not blocked', () => {
  const dir = scratch();
  run(dir);
  assert.equal(existsSync(join(dir, 'run.lock')), false, 'lock leaked');
  assert.equal(run(dir).status, 0);
});

test('the lock is released even when the sync conflicts', () => {
  const dir = scratch();
  run(dir, { brainSyncExit: 1 });
  assert.equal(existsSync(join(dir, 'run.lock')), false, 'a conflict left the lock behind forever');
});

test('a failing human-needed call does not turn into a crash', () => {
  const dir = scratch();
  const r = run(dir, { brainSyncExit: 1, humanNeededExit: 1 });
  assert.equal(r.status, 3, 'the conflict verdict must survive a broken alert channel');
});

// ── half-merged working tree ──────────────────────────────────────────────────
//
// The case that motivated this guard is not hypothetical: nexus/personal-brain/graph.json in the
// shared brain had six `<<<<<<< HEAD` markers *committed* and pushed to every host. brain-sync.js
// stages with `git add -A` before it pulls, so it cannot notice — to it, markers are file content.

test('conflictedFiles lists tracked files carrying markers and is quiet when there are none', () => {
  const found = conflictedFiles('/whatever', () => ({ status: 0, stdout: 'nexus/a/graph.json\nnodes/b.md\n' }));
  assert.deepEqual(found, ['nexus/a/graph.json', 'nodes/b.md']);

  // git grep exits 1 for "no matches", which is the healthy tree, not an error.
  assert.deepEqual(conflictedFiles('/whatever', () => ({ status: 1, stdout: '' })), []);
  // Not a git repo / no HEAD: leave the diagnosis to brain-sync rather than inventing a conflict.
  assert.deepEqual(conflictedFiles('/whatever', () => ({ status: 128, stdout: '' })), []);
});

/** A real repo with a marker-carrying file committed to it — the state that actually shipped. */
function halfMergedRepo(dir, { markers = true } = {}) {
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'graph.json'), markers
    ? '{\n<<<<<<< HEAD\n  "a": 1\n=======\n  "a": 2\n>>>>>>> other\n}\n'
    : '{\n  "a": 1\n}\n');
  git('add', 'graph.json');
  git('commit', '-qm', 'x');
}

test('a tree with committed conflict markers never reaches brain-sync', () => {
  const dir = scratch();
  halfMergedRepo(dir);
  const r = run(dir);

  assert.equal(r.status, 3, `expected 3 (conflict, alert raised), got ${r.status}: ${r.stderr}`);
  assert.equal(r.brain.calls().length, 0,
    'brain-sync ran on a half-merged tree — `git add -A` would commit the markers and push them to every host');
  assert.match(r.stderr, /graph\.json/);

  const calls = r.human.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'raise');
  assert.equal(calls[0][1], KEY, 'a stuck tree and a failed merge are one outage, so one key');
  assert.match(calls[0].join(' '), /graph\.json/);
  assert.equal(existsSync(join(dir, 'alert.state')), true);
});

test('the marker alert tells the operator how to rebuild a graph.json, and still names no merge strategy', () => {
  const joined = raiseArgs({ root: '/r', host: 'box', detail: 'graph.json', kind: 'markers' }).join(' ');
  assert.match(joined, /add -A/, 'the operator needs to know why the markers were committed silently');
  assert.match(joined, /graph-init/);
  assert.doesNotMatch(joined, /-X (ours|theirs)/);
});

test('a clean tracked tree is unaffected by the preflight', () => {
  const dir = scratch();
  halfMergedRepo(dir, { markers: false });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.brain.calls().length, 1, 'the preflight blocked a healthy repo');
});

// The scan is right far more often than it is wrong, so it stays on by default — but it can be
// wrong: a brain node that legitimately quotes conflict-marker text (the brain now records this very
// incident, so that is not hypothetical) would block sync on every host forever, with no way out
// except editing memory to appease a checker.
test('--ignore-markers is the escape hatch for a node that legitimately quotes markers', () => {
  const dir = scratch();
  halfMergedRepo(dir);
  const r = run(dir, { extra: ['--ignore-markers'] });

  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.brain.calls().length, 1, 'the override did not let the sync through');
  assert.equal(r.human.calls().length, 0);
});

// brain-sync.js carries the same marker scan (#348), because the alert body and the docs both tell
// a person to run it directly. Not forwarding the override means the operator clears the wrapper
// and is stopped one level down by a guard taking no flags — an escape hatch that escapes nothing.
test('--ignore-markers is forwarded to brain-sync, not just consumed by the preflight', () => {
  const dir = scratch();
  halfMergedRepo(dir);
  const r = run(dir, { extra: ['--ignore-markers'] });
  assert.deepEqual(r.brain.calls()[0], ['--path', dir, '--ignore-markers']);
});

// It suppresses a scan; it never resolves anything. If this ever grows a `-X ours` sibling, the
// wrapper has started deciding which side of a memory node is right.
test('no flag that resolves a conflict is ever forwarded', () => {
  const dir = scratch();
  const r = run(dir, { extra: ['--ignore-markers'] });
  assert.doesNotMatch(r.brain.calls().join(' '), /-X |ours|theirs|--force|--reset/);
});

test('the lock is released when the preflight stops the run', () => {
  const dir = scratch();
  halfMergedRepo(dir);
  run(dir);
  assert.equal(existsSync(join(dir, 'run.lock')), false, 'a stuck tree left the lock behind forever');
});
