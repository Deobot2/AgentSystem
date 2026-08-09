// tests/memory-decay.test.js
// Regression test: `node tools/memory-decay.js --brain=<slug>` must not hard-exit(1) when
// the brain's graph.json doesn't exist yet. A per-repo/agent brain is gitignored, so a fresh
// host (or a brain nothing has written to yet) legitimately has no graph.json -- that's a
// normal state, not a corruption (CLAUDE.md "Central brain"). Before the fix, memory-decay.js
// treated a missing graph.json as fatal, which took down the `weekly-memory-decay` scheduled
// job the moment any listed brain lacked a graph.json on the runner (run
// https://github.com/Zene8/AgentSystem/actions/runs/31288224604).
//
// node --test tests/memory-decay.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(repoRoot, 'tools', 'memory-decay.js');

function runDecay(memoryRoot, brain) {
  return execFileSync(process.execPath, [SCRIPT, `--brain=${brain}`], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_MEMORY_ROOT: memoryRoot },
  });
}

test('memory-decay: missing graph.json is skipped, not a fatal error', () => {
  const memoryRoot = mkdtempSync(join(tmpdir(), 'memory-decay-test-'));
  try {
    // No nexus/<brain>/graph.json exists under this fresh root at all.
    const stdout = runDecay(memoryRoot, 'never-initialized-brain');
    assert.match(stdout, /skipping/i, `expected a skip message, got: ${stdout}`);
    assert.doesNotMatch(stdout, /archived/i, 'a skip must not read like a real decay pass');

    const graphPath = join(memoryRoot, 'nexus', 'never-initialized-brain', 'graph.json');
    assert.equal(existsSync(graphPath), false, 'must not create a placeholder graph.json');
  } finally {
    rmSync(memoryRoot, { recursive: true, force: true });
  }
});

// --- #314: the job that reported success while decaying nothing --------------------------------
// `weekly-memory-decay` ran `--brain=agentsystem` on every schedule. Repo brains live at
// <repo>/nexus/<slug>/ and are gitignored (graph-init.js), so that slug names a path that cannot
// exist under ~/agent-memory/nexus/ on any host -- the skip above then made the run green.
// --all discovers the brains that are actually there; a host with none is an error, not a no-op.

function run(memoryRoot, args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_MEMORY_ROOT: memoryRoot },
  });
}

function runExpectingFailure(memoryRoot, args) {
  try {
    run(memoryRoot, args);
  } catch (err) {
    return { status: err.status, stderr: err.stderr || '', stdout: err.stdout || '' };
  }
  assert.fail('expected a non-zero exit');
}

// One stale edge (last visited long ago, no other signal) so a real decay pass has something to do.
function seedBrain(memoryRoot, brain) {
  const dir = join(memoryRoot, 'nexus', brain);
  mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 500 * 24 * 60 * 60 * 1000).toISOString();
  writeFileSync(join(dir, 'graph.json'), JSON.stringify({
    nodes: ['a', 'b'],
    edges: [{
      source: 'a',
      target: 'b',
      weights: {
        co_change: 0, semantic: 0, _visit_raw: 4, visit_count: 4, last_visited: old,
        confidence: { n_confirms: 0, n_contradicts: 8 },
        valid_from: old, valid_until: null,
      },
      composite: 0.4,
    }],
  }, null, 2));
  return join(dir, 'graph.json');
}

function withRoot(fn) {
  const memoryRoot = mkdtempSync(join(tmpdir(), 'memory-decay-test-'));
  try {
    fn(memoryRoot);
  } finally {
    rmSync(memoryRoot, { recursive: true, force: true });
  }
}

test('memory-decay --all: a host with no brains is an error, not a silent success', () => {
  withRoot((memoryRoot) => {
    const { status, stderr } = runExpectingFailure(memoryRoot, ['--all']);
    assert.equal(status, 1);
    assert.match(stderr, /no brains found/i);
  });
});

test('memory-decay --all: discovers top-level and agent-brain/<agent> brains', () => {
  withRoot((memoryRoot) => {
    seedBrain(memoryRoot, 'personal-brain');
    seedBrain(memoryRoot, join('agent-brain', 'leo'));
    // agent-brain itself is a container, not a brain -- it must not be reported as one.
    const stdout = run(memoryRoot, ['--all', '--dry-run']);
    assert.match(stdout, /2 brain\(s\) found/);
    assert.match(stdout, /personal-brain/);
    assert.match(stdout, /agent-brain\/leo/);
    assert.doesNotMatch(stdout, /decay pass \[agent-brain\]/);
  });
});

test('memory-decay --all: archives stale edges and marks them inactive in weights', () => {
  withRoot((memoryRoot) => {
    const graphPath = seedBrain(memoryRoot, 'personal-brain');
    const stdout = run(memoryRoot, ['--all']);
    assert.match(stdout, /1 edges archived/);
    assert.match(stdout, /1 brain\(s\) processed, 1 edge\(s\) archived/);

    const edge = JSON.parse(readFileSync(graphPath, 'utf8')).edges[0];
    assert.notEqual(edge.weights.valid_until, null,
      'valid_until must be stamped inside weights -- that is where the active check reads it');

    // Second pass must find nothing left to archive. Before the fix it re-archived the same edge
    // every run, which is what "decays nothing, forever" actually looked like on disk.
    assert.match(run(memoryRoot, ['--all']), /0 edges archived/);
  });
});

test('memory-decay --require-graph: a named-but-missing brain fails loudly', () => {
  withRoot((memoryRoot) => {
    const { status, stderr } = runExpectingFailure(memoryRoot, ['--brain=personal-brain', '--require-graph']);
    assert.equal(status, 1);
    assert.match(stderr, /refusing to report success/i);
  });
});

test('memory-decay: --brain and --all are mutually exclusive', () => {
  withRoot((memoryRoot) => {
    const { status } = runExpectingFailure(memoryRoot, ['--brain=personal-brain', '--all']);
    assert.equal(status, 1);
  });
});
