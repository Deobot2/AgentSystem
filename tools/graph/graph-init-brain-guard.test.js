// graph-init-brain-guard.test.js — #346: graph-init.js must refuse a positional repo-path that
// is actually a brain directory, and must print the resolved ABSOLUTE output path on success.
//
// graph-init.js runs top-level code (not exported functions), so it is exercised as a subprocess.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./graph-init.js', import.meta.url));

function run(args, opts = {}) {
  try {
    const out = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', ...opts });
    return { code: 0, stdout: out, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
  }
}

test('refuses a positional repo-path holding graph.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-init-brain-guard-'));
  try {
    writeFileSync(join(dir, 'graph.json'), JSON.stringify({ version: '1.0', nodes: [], edges: [] }), 'utf8');
    const result = run(['some-slug', dir]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /refusing/);
    assert.match(result.stderr, /--brain-path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses a positional repo-path ending in nexus/<slug>', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-init-brain-guard-'));
  try {
    const brainDir = join(root, 'nexus', 'personal-brain');
    mkdirSync(brainDir, { recursive: true });
    const result = run(['personal-brain', brainDir]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /refusing/);
    assert.match(result.stderr, /--brain-path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('on success prints the resolved absolute output path, not a relative form', () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-init-brain-guard-'));
  try {
    // Not a git repo and not a brain dir — an ordinary empty directory.
    const result = run(['ordinary-slug', dir]);
    assert.equal(result.code, 0);
    const expectedNexusDir = join(dir, 'nexus', 'ordinary-slug');
    assert.match(result.stdout, /graph-init: \d+ nodes, \d+ edges → /);
    assert.ok(
      result.stdout.includes(expectedNexusDir),
      `expected stdout to include absolute path ${expectedNexusDir}, got: ${result.stdout}`
    );
    // The old buggy form ("→ nexus/<slug>/\n") must not appear.
    assert.ok(
      !/→ nexus\/ordinary-slug\/\s*$/.test(result.stdout.trim()),
      `stdout still uses the old relative form: ${result.stdout}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('still accepts --brain-path pointed at a brain dir (does not refuse)', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-init-brain-guard-'));
  try {
    const brainDir = join(root, 'nexus', 'personal-brain');
    mkdirSync(brainDir, { recursive: true });
    // Run from an arbitrary cwd (root) with no positional repo-path — brain-path only.
    const result = run(['personal-brain', `--brain-path=${brainDir}`], { cwd: root });
    assert.equal(result.code, 0, `expected success, got stderr: ${result.stderr}`);
    assert.match(result.stdout, /graph-init: \d+ nodes, \d+ edges → /);
    assert.ok(result.stdout.includes(brainDir));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
