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
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
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
