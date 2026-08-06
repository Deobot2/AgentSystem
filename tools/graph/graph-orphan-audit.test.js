import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findOrphans, discoverBrains } from './graph-orphan-audit.js';

describe('findOrphans', () => {
  it('returns only nodes no edge touches, sorted', () => {
    const graph = {
      nodes: ['zeta', 'alpha', 'beta', 'gamma'],
      edges: [{ source: 'alpha', target: 'beta' }],
    };
    assert.deepEqual(findOrphans(graph), ['gamma', 'zeta']);
  });

  it('counts a node linked as target only as connected', () => {
    const graph = { nodes: ['a', 'b'], edges: [{ source: 'a', target: 'b' }] };
    assert.deepEqual(findOrphans(graph), []);
  });

  it('tolerates a graph with no edges key', () => {
    assert.deepEqual(findOrphans({ nodes: ['solo'] }), ['solo']);
  });
});

describe('discoverBrains', () => {
  it('finds nested brains, skips nodes/ and dotdirs', () => {
    const root = join(tmpdir(), `orphan-audit-test-${process.pid}`);
    rmSync(root, { recursive: true, force: true });
    try {
      const graph = JSON.stringify({ nodes: [], edges: [] });
      for (const rel of ['personal-brain', join('agent-brain', 'friday')]) {
        mkdirSync(join(root, rel, 'nodes'), { recursive: true });
        writeFileSync(join(root, rel, 'graph.json'), graph, 'utf8');
      }
      // Decoys: a nodes/ subtree and a dotdir that both contain a graph.json.
      writeFileSync(join(root, 'personal-brain', 'nodes', 'graph.json'), graph, 'utf8');
      mkdirSync(join(root, '.git'), { recursive: true });
      writeFileSync(join(root, '.git', 'graph.json'), graph, 'utf8');

      assert.deepEqual(discoverBrains(root), [
        join(root, 'agent-brain', 'friday'),
        join(root, 'personal-brain'),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns [] for a missing root', () => {
    assert.deepEqual(discoverBrains(join(tmpdir(), 'orphan-audit-does-not-exist')), []);
  });
});
