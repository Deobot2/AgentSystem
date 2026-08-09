// graph-reindex.test.js — #252: safely rebuild graph.json from nodes/*.md without touching any
// node file. See tools/graph-reindex.js header for why graph-init.js is the wrong tool for this.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readGraph, emptyGraph, writeGraph, serializeFrontmatter } from './graph/graph-lib.js';
import { reindexBrain, discoverBrains, findMissingNodes } from './graph-reindex.js';

function makeNode(nodesDir, id, connections = []) {
  const fm = { id, type: 'fact', brain: 'test', created: '2026-08-09', connections };
  writeFileSync(join(nodesDir, `${id}.md`), serializeFrontmatter(fm, `# ${id}\n`), 'utf8');
}

test('reindex adds missing nodes to graph.json without touching node file contents', () => {
  const brain = mkdtempSync(join(tmpdir(), 'graph-reindex-'));
  try {
    const nodesDir = join(brain, 'nodes');
    mkdirSync(nodesDir, { recursive: true });
    makeNode(nodesDir, 'alpha');
    makeNode(nodesDir, 'beta');

    // graph.json starts empty (unindexed) — same shape as #252's "75 nodes missing" finding.
    writeGraph(join(brain, 'graph.json'), emptyGraph('test', 'test'));

    const alphaBefore = readFileSync(join(nodesDir, 'alpha.md'), 'utf8');
    const alphaMtimeBefore = statSync(join(nodesDir, 'alpha.md')).mtimeMs;

    const { added } = reindexBrain(brain);

    assert.deepEqual(added.sort(), ['alpha', 'beta']);
    const graph = readGraph(join(brain, 'graph.json'));
    assert.deepEqual(graph.nodes.sort(), ['alpha', 'beta']);

    // Node file must be byte-identical — reindex never writes to nodes/.
    const alphaAfter = readFileSync(join(nodesDir, 'alpha.md'), 'utf8');
    assert.equal(alphaAfter, alphaBefore);
    assert.equal(statSync(join(nodesDir, 'alpha.md')).mtimeMs, alphaMtimeBefore);
  } finally {
    rmSync(brain, { recursive: true, force: true });
  }
});

test('edges are derived from connections: frontmatter wikilinks', () => {
  const brain = mkdtempSync(join(tmpdir(), 'graph-reindex-'));
  try {
    const nodesDir = join(brain, 'nodes');
    mkdirSync(nodesDir, { recursive: true });
    makeNode(nodesDir, 'alpha', ['[[beta]]']);
    makeNode(nodesDir, 'beta');
    makeNode(nodesDir, 'gamma', ['[[does-not-exist]]']); // dangling link — no edge

    writeGraph(join(brain, 'graph.json'), emptyGraph('test', 'test'));
    const { edgesAdded } = reindexBrain(brain);

    assert.equal(edgesAdded, 1);
    const graph = readGraph(join(brain, 'graph.json'));
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0].source, 'alpha');
    assert.equal(graph.edges[0].target, 'beta');
  } finally {
    rmSync(brain, { recursive: true, force: true });
  }
});

test('reindex is idempotent — running twice does not duplicate nodes or edges', () => {
  const brain = mkdtempSync(join(tmpdir(), 'graph-reindex-'));
  try {
    const nodesDir = join(brain, 'nodes');
    mkdirSync(nodesDir, { recursive: true });
    makeNode(nodesDir, 'alpha', ['[[beta]]']);
    makeNode(nodesDir, 'beta');
    writeGraph(join(brain, 'graph.json'), emptyGraph('test', 'test'));

    reindexBrain(brain);
    reindexBrain(brain);

    const graph = readGraph(join(brain, 'graph.json'));
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.edges.length, 1);
  } finally {
    rmSync(brain, { recursive: true, force: true });
  }
});

test('--check semantics: findMissingNodes reports drift, empty when clean', () => {
  const brain = mkdtempSync(join(tmpdir(), 'graph-reindex-'));
  try {
    const nodesDir = join(brain, 'nodes');
    mkdirSync(nodesDir, { recursive: true });
    makeNode(nodesDir, 'alpha');
    makeNode(nodesDir, 'beta');

    let graph = emptyGraph('test', 'test');
    assert.deepEqual(findMissingNodes(graph, nodesDir).sort(), ['alpha', 'beta']);

    writeGraph(join(brain, 'graph.json'), graph);
    reindexBrain(brain);
    graph = readGraph(join(brain, 'graph.json'));
    assert.deepEqual(findMissingNodes(graph, nodesDir), []);
  } finally {
    rmSync(brain, { recursive: true, force: true });
  }
});

test('discoverBrains sweeps personal-brain and every agent-brain/<agent>', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-reindex-root-'));
  try {
    mkdirSync(join(root, 'personal-brain'), { recursive: true });
    mkdirSync(join(root, 'agent-brain', 'jarvis'), { recursive: true });
    mkdirSync(join(root, 'agent-brain', 'friday'), { recursive: true });

    const found = discoverBrains(root);
    assert.deepEqual(found.sort(), [
      join(root, 'agent-brain', 'friday'),
      join(root, 'agent-brain', 'jarvis'),
      join(root, 'personal-brain'),
    ].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sweeping multiple brain dirs reindexes each independently', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-reindex-root-'));
  try {
    const personal = join(root, 'personal-brain');
    const jarvis = join(root, 'agent-brain', 'jarvis');
    mkdirSync(join(personal, 'nodes'), { recursive: true });
    mkdirSync(join(jarvis, 'nodes'), { recursive: true });
    makeNode(join(personal, 'nodes'), 'p1');
    makeNode(join(jarvis, 'nodes'), 'j1');
    writeGraph(join(personal, 'graph.json'), emptyGraph('personal', undefined));
    writeGraph(join(jarvis, 'graph.json'), emptyGraph('agent', 'jarvis'));

    for (const brain of discoverBrains(root)) reindexBrain(brain);

    assert.deepEqual(readGraph(join(personal, 'graph.json')).nodes, ['p1']);
    assert.deepEqual(readGraph(join(jarvis, 'graph.json')).nodes, ['j1']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
