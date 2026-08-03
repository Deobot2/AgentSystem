// brain-sync.test.js — exercises tools/brain-sync.js against real git repos, no network.
//
// Worth testing rather than eyeballing: this tool commits and pushes to a git history shared by
// every host running AgentSystem. The branch that matters most is the conflict classifier — a
// conflict in the generated graph.json is auto-resolved, a conflict in an authored node must stop
// for a human. Get that backwards and the tool silently discards someone's facts.
//
// Two working checkouts share one bare origin, standing in for the laptop and the server.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'brain-sync.js');
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...IDENT, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}

function sync(cwd, extra = []) {
  const r = spawnSync(process.execPath, [TOOL, '--path', cwd, ...extra], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// One origin, two clones. Returns absolute paths.
function makeWorld() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'brainsync-'));
  const origin = path.join(base, 'origin.git');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);

  const seed = path.join(base, 'seed');
  fs.mkdirSync(path.join(seed, 'nexus', 'personal-brain', 'nodes'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'nexus', 'personal-brain', 'nodes', 'shared.md'), 'seed\n');
  fs.writeFileSync(path.join(seed, 'nexus', 'personal-brain', 'graph.json'), '{"nodes":[]}\n');
  git(seed, ['init', '-q', '-b', 'main']);
  git(seed, ['remote', 'add', 'origin', origin]);
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'seed']);
  git(seed, ['push', '-q', 'origin', 'main']);

  const hosts = ['hostA', 'hostB'].map((n) => {
    const p = path.join(base, n);
    spawnSync('git', ['clone', '-q', origin, p]);
    return p;
  });
  return { base, origin, hosts };
}

test('--status reports without changing anything', () => {
  const { base, hosts: [a] } = makeWorld();
  try {
    fs.writeFileSync(path.join(a, 'nexus', 'personal-brain', 'nodes', 'new.md'), 'x\n');
    const before = git(a, ['rev-parse', 'HEAD']);
    const r = sync(a, ['--status']);
    assert.equal(r.code, 0);
    assert.match(r.out, /uncommitted change/);
    assert.equal(git(a, ['rev-parse', 'HEAD']), before, '--status must not commit');
    assert.notEqual(git(a, ['status', '--porcelain']), '', '--status must not stage');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('local changes are committed and pushed', () => {
  const { base, hosts: [a, b] } = makeWorld();
  try {
    fs.writeFileSync(path.join(a, 'nexus', 'personal-brain', 'nodes', 'from-a.md'), 'a\n');
    const r = sync(a);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /pushed 1 commit/);

    // The other host must actually see it — the point of the whole exercise.
    git(b, ['pull', '-q', '--no-rebase', 'origin', 'main']);
    assert.ok(fs.existsSync(path.join(b, 'nexus', 'personal-brain', 'nodes', 'from-a.md')));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a clean checkout with nothing outgoing is a no-op', () => {
  const { base, hosts: [a] } = makeWorld();
  try {
    const r = sync(a);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /up to date/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('conflict in generated graph.json is auto-resolved, keeping the local side', () => {
  const { base, hosts: [a, b] } = makeWorld();
  const rel = path.join('nexus', 'personal-brain', 'graph.json');
  try {
    // B publishes its version first, so A's pull collides.
    fs.writeFileSync(path.join(b, rel), '{"nodes":["from-b"]}\n');
    assert.equal(sync(b).code, 0);

    fs.writeFileSync(path.join(a, rel), '{"nodes":["from-a"]}\n');
    const r = sync(a);
    assert.equal(r.code, 0, `expected auto-resolve, got: ${r.err}`);
    assert.match(r.out, /resolved 1 generated graph\.json conflict/);
    assert.match(fs.readFileSync(path.join(a, rel), 'utf8'), /from-a/,
      'local side must win: graph.json is regenerated from nodes/ anyway');
    assert.equal(git(a, ['status', '--porcelain']), '', 'merge must be committed, not left mid-merge');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('conflict in an authored node stops for a human and leaves the merge in place', () => {
  const { base, hosts: [a, b] } = makeWorld();
  const rel = path.join('nexus', 'personal-brain', 'nodes', 'shared.md');
  try {
    fs.writeFileSync(path.join(b, rel), 'B learned something\n');
    assert.equal(sync(b).code, 0);

    fs.writeFileSync(path.join(a, rel), 'A learned something else\n');
    const r = sync(a);
    assert.equal(r.code, 1, 'a real content conflict must not be auto-resolved');
    assert.match(r.err, /needs a human/);
    assert.match(r.err, /shared\.md/);
    assert.notEqual(git(a, ['status', '--porcelain']), '',
      'conflict must be left in the worktree for the human to resolve');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('--pull-only merges without pushing', () => {
  const { base, hosts: [a, b] } = makeWorld();
  try {
    fs.writeFileSync(path.join(b, 'nexus', 'personal-brain', 'nodes', 'from-b.md'), 'b\n');
    assert.equal(sync(b).code, 0);

    fs.writeFileSync(path.join(a, 'nexus', 'personal-brain', 'nodes', 'from-a.md'), 'a\n');
    const r = sync(a, ['--pull-only']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /not pushing/);
    assert.ok(fs.existsSync(path.join(a, 'nexus', 'personal-brain', 'nodes', 'from-b.md')),
      'pull must still have happened');
    assert.notEqual(git(a, ['rev-list', '--count', 'origin/main..HEAD']), '0',
      'local commit must remain unpushed');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a directory that is not a git checkout exits 2 with the clone hint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainsync-nogit-'));
  try {
    const r = sync(dir);
    assert.equal(r.code, 2);
    assert.match(r.err, /no git checkout/);
    assert.match(r.err, /clone it first/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unknown flag exits 2 rather than guessing', () => {
  const r = spawnSync(process.execPath, [TOOL, '--wat'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option/);
});
