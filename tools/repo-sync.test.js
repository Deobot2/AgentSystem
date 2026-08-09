#!/usr/bin/env node
// repo-sync.js — pull the AgentSystem checkout forward at session start (#341).
//
// The whole point is the *refusals*: this runs unattended on every host, so anything other than
// "on main, clean, fast-forward" must be a silent no-op. A tool that pulls under a dirty tree, or
// that touches a feature branch, would eat work nobody asked it to touch.
//
// Integration tests use real git repos in a temp dir rather than a mocked runner. The behaviours
// that matter here (does --ff-only refuse a diverged branch, does a dirty tree survive) are git's,
// not ours, and mocking them would only test the mock.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { decide } from './repo-sync.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'repo-sync.js');

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

function scenario() {
  const root = mkdtempSync(join(tmpdir(), 'repo-sync-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const clone = join(root, 'clone');

  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  mkdirSync(seed);
  git(seed, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(seed, 'a.txt'), 'one\n');
  git(seed, 'add', '-A');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'one');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '--quiet', 'origin', 'main');

  execFileSync('git', ['clone', '--quiet', origin, clone]);
  return { root, origin, seed, clone };
}

/** Add a commit to origin, so the clone is one behind. */
function advanceOrigin(s, text = 'two\n') {
  writeFileSync(join(s.seed, 'b.txt'), text);
  git(s.seed, 'add', '-A');
  git(s.seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'two');
  git(s.seed, 'push', '--quiet', 'origin', 'main');
}

const run = (path, ...extra) => execFileSync(process.execPath, [SCRIPT, '--path', path, ...extra], { encoding: 'utf8' });

// ── the decision, in isolation ────────────────────────────────────────────────

test('decide: syncs only on a clean main with an origin', () => {
  assert.equal(decide({ branch: 'main', dirty: '', hasOrigin: true }).sync, true);
});

test('decide: refuses a feature branch', () => {
  const d = decide({ branch: 'issue-341-continuous-sync', dirty: '', hasOrigin: true });
  assert.equal(d.sync, false);
  assert.match(d.reason, /branch/);
});

test('decide: refuses a dirty tree', () => {
  const d = decide({ branch: 'main', dirty: ' M tools/x.js', hasOrigin: true });
  assert.equal(d.sync, false);
  assert.match(d.reason, /uncommitted/);
});

test('decide: refuses a checkout with no origin remote', () => {
  const d = decide({ branch: 'main', dirty: '', hasOrigin: false });
  assert.equal(d.sync, false);
  assert.match(d.reason, /origin/);
});

test('decide: refuses a detached HEAD', () => {
  assert.equal(decide({ branch: 'HEAD', dirty: '', hasOrigin: true }).sync, false);
});

// ── end to end, against real git ──────────────────────────────────────────────

test('fast-forwards a clean main', () => {
  const s = scenario();
  const before = git(s.clone, 'rev-parse', 'HEAD');
  advanceOrigin(s);

  const out = run(s.clone);
  assert.notEqual(git(s.clone, 'rev-parse', 'HEAD'), before, 'clone did not move');
  assert.match(out, /pulled/);
});

test('a dirty tree is left completely alone, and says nothing', () => {
  const s = scenario();
  const before = git(s.clone, 'rev-parse', 'HEAD');
  writeFileSync(join(s.clone, 'a.txt'), 'local edit\n');
  advanceOrigin(s);

  const out = run(s.clone);
  assert.equal(out, '', `expected silence on skip, got: ${out}`);
  assert.equal(git(s.clone, 'rev-parse', 'HEAD'), before, 'pulled under a dirty tree');
  assert.match(git(s.clone, 'status', '--porcelain'), /a\.txt/, 'local edit was destroyed');
});

test('a feature branch is never touched', () => {
  const s = scenario();
  git(s.clone, 'checkout', '--quiet', '-b', 'issue-999-thing');
  const before = git(s.clone, 'rev-parse', 'HEAD');
  advanceOrigin(s);

  assert.equal(run(s.clone), '');
  assert.equal(git(s.clone, 'rev-parse', 'HEAD'), before);
});

test('a local commit on main that origin does not have is not clobbered', () => {
  const s = scenario();
  writeFileSync(join(s.clone, 'local.txt'), 'mine\n');
  git(s.clone, 'add', '-A');
  git(s.clone, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'local');
  const before = git(s.clone, 'rev-parse', 'HEAD');
  advanceOrigin(s);

  run(s.clone); // --ff-only must refuse; the tool must not escalate to a merge
  assert.equal(git(s.clone, 'rev-parse', 'HEAD'), before, 'diverged main was rewritten');
});

test('--dry-run reports the decision and changes nothing', () => {
  const s = scenario();
  const before = git(s.clone, 'rev-parse', 'HEAD');
  advanceOrigin(s);

  const out = run(s.clone, '--dry-run');
  assert.match(out, /would pull/);
  assert.equal(git(s.clone, 'rev-parse', 'HEAD'), before);
});

test('a path that is not a git checkout exits 0 in silence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-sync-nogit-'));
  assert.equal(run(dir), '');
});
