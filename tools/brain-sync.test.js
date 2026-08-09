#!/usr/bin/env node
// brain-sync.js — the parts of the sync whose behaviour is a promise to the user (#341).
//
// Not a full test of git. What is pinned here is the one thing the continuous-sync triggers depend
// on: `--pull-only` writes nothing. It runs at SessionStart, on every session, on every host — so if
// it commits, then an editor left mid-thought, a half-finished merge or a scratch file becomes a
// permanent commit that the next full sync pushes to every machine, without anyone asking for it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'brain-sync.js');

const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const sync = (root, ...args) =>
  spawnSync(process.execPath, [SCRIPT, '--path', root, ...args], { encoding: 'utf8' });

/** A clone with a real origin, so pull and push are exercised rather than stubbed. */
function brainWithRemote() {
  const base = mkdtempSync(join(tmpdir(), 'brain-sync-'));
  const remote = join(base, 'remote.git');
  const work = join(base, 'work');
  mkdirSync(remote);
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);

  spawnSync('git', ['clone', '-q', remote, work]);
  git(work, 'config', 'user.email', 't@t');
  git(work, 'config', 'user.name', 't');
  git(work, 'checkout', '-q', '-B', 'main');
  writeFileSync(join(work, 'seed.md'), 'seed\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'seed');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  return { base, remote, work };
}

const commitCount = (work) => Number(git(work, 'rev-list', '--count', 'HEAD').stdout.trim());
const isDirty = (work) => git(work, 'status', '--porcelain').stdout.trim() !== '';

test('--pull-only leaves local changes uncommitted', () => {
  const { work } = brainWithRemote();
  const before = commitCount(work);
  writeFileSync(join(work, 'draft.md'), 'half a thought\n');

  const r = sync(work, '--pull-only');

  assert.equal(r.status, 0, r.stderr);
  assert.equal(commitCount(work), before, '--pull-only committed — it is supposed to write nothing');
  assert.equal(isDirty(work), true, 'the local edit was staged away by a pull');
});

test('--pull-only on a dirty tree is not reported as a conflict needing a human', () => {
  const { work } = brainWithRemote();
  writeFileSync(join(work, 'draft.md'), 'half a thought\n');

  const r = sync(work, '--pull-only');
  // The wrapper keys its alert off this exact phrase. An uncommitted file is not a merge to resolve,
  // and raising it as one would open an issue at every session start on any host with unsaved work.
  assert.doesNotMatch(r.stderr, /merge conflict needs a human/);
  assert.equal(r.status, 0);
});

test('--pull-only still fast-forwards what the remote has', () => {
  const { remote, work } = brainWithRemote();
  const other = mkdtempSync(join(tmpdir(), 'brain-other-'));
  spawnSync('git', ['clone', '-q', remote, other]);
  git(other, 'config', 'user.email', 't@t');
  git(other, 'config', 'user.name', 't');
  writeFileSync(join(other, 'from-elsewhere.md'), 'written on another host\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-qm', 'elsewhere');
  git(other, 'push', '-q', 'origin', 'main');

  const before = commitCount(work);
  const r = sync(work, '--pull-only');

  assert.equal(r.status, 0, r.stderr);
  assert.equal(commitCount(work), before + 1, 'pull-only pulled nothing');
});

test('a full sync does commit and push local work', () => {
  const { remote, work } = brainWithRemote();
  writeFileSync(join(work, 'note.md'), 'a real memory write\n');

  const r = sync(work);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(isDirty(work), false, 'a full sync left the tree dirty');
  const pushed = spawnSync('git', ['-C', remote, 'log', '-1', '--format=%s'], { encoding: 'utf8' });
  assert.match(pushed.stdout, /brain: sync from /);
});
