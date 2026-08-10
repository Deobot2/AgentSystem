import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  emptyGraph, addNode, addEdge,
  spreadingActivation, updateConfidence,
  decayedVisitScore, enforceEdgeCap, recomputeComposite,
  parseFrontmatter, needProbabilityScore,
  effectiveImportance, nodeAccessSignal,
  isBrainDir,
} from './graph-lib.js';

// #375: a directory under nexus/ is a brain only on positive evidence -- a nodes/ subdirectory,
// or a graph.json with a real (non-"unknown") brain field. Dotfile dirs (.obsidian, an Obsidian
// vault's own graph-VIEW settings file) and a bare directory literally named "nodes" are never
// brains, no matter what they contain.
test('isBrainDir: true for a dir with a nodes/ subdirectory', () => {
  const root = mkdtempSync(join(tmpdir(), 'isbraindir-'));
  try {
    const brain = join(root, 'personal-brain');
    mkdirSync(join(brain, 'nodes'), { recursive: true });
    assert.equal(isBrainDir(brain), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isBrainDir: true for a dir with a graph.json carrying a real brain field', () => {
  const root = mkdtempSync(join(tmpdir(), 'isbraindir-'));
  try {
    const brain = join(root, 'agentsystem');
    mkdirSync(brain, { recursive: true });
    writeFileSync(join(brain, 'graph.json'), JSON.stringify({ brain: 'agentsystem', nodes: [], edges: [] }), 'utf8');
    assert.equal(isBrainDir(brain), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isBrainDir: false for a dotfile dir even with a graph.json inside (.obsidian)', () => {
  const root = mkdtempSync(join(tmpdir(), 'isbraindir-'));
  try {
    const obsidian = join(root, '.obsidian');
    mkdirSync(obsidian, { recursive: true });
    writeFileSync(join(obsidian, 'graph.json'), JSON.stringify({ nodes: [], edges: [] }), 'utf8');
    assert.equal(isBrainDir(obsidian), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isBrainDir: false for a bare directory literally named nodes', () => {
  const root = mkdtempSync(join(tmpdir(), 'isbraindir-'));
  try {
    const nested = join(root, 'agent-brain', 'nodes');
    mkdirSync(nested, { recursive: true });
    assert.equal(isBrainDir(nested), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isBrainDir: false for a graph.json whose brain field is "unknown" or missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'isbraindir-'));
  try {
    const dir = join(root, 'scratch');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'graph.json'), JSON.stringify({ brain: 'unknown', nodes: [], edges: [] }), 'utf8');
    assert.equal(isBrainDir(dir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('needProbabilityScore: importance 0 is neutral, higher importance boosts', () => {
  assert.strictEqual(needProbabilityScore(0.4, 0), 0.4, 'importance 0 leaves score unchanged');
  assert.strictEqual(needProbabilityScore(0.4, undefined), 0.4, 'absent importance is neutral');
  assert.strictEqual(needProbabilityScore(0.4, 1, 0.5), 0.6, 'max importance with gain 0.5 → 1.5x');
  assert.ok(needProbabilityScore(0.4, 0.5) > 0.4, 'mid importance boosts above base');
  assert.strictEqual(needProbabilityScore(0.4, 5), 0.6, 'importance clamped to 1');
});

test('parseFrontmatter coerces unquoted true/false to booleans', () => {
  const { frontmatter } = parseFrontmatter('---\nhot: true\ncold: false\nname: truevalue\n---\nbody');
  assert.strictEqual(frontmatter.hot, true, 'hot:true must be boolean true');
  assert.strictEqual(frontmatter.cold, false, 'cold:false must be boolean false');
  assert.strictEqual(frontmatter.name, 'truevalue', 'non-boolean strings unchanged');
});

// Helper: build a graph with N nodes and edges from node0 to all others with given composite
function hubGraph(hubCount = 20) {
  let g = emptyGraph('test', 'test');
  for (let i = 0; i <= hubCount; i++) g = addNode(g, `n${i}`);
  // Manually add edges with composite set so enforceEdgeCap can sort them
  for (let i = 1; i <= hubCount; i++) {
    g = addEdge(g, 'n0', `n${i}`);
    // Set composite to i so we know which is lowest
    g = {
      ...g,
      edges: g.edges.map(e =>
        (e.source === 'n0' && e.target === `n${i}`) ? { ...e, composite: i } : e
      ),
    };
  }
  return g;
}

// 1. Lateral inhibition limits active nodes to 7 per hop
// Strategy: seed → 20 layer1 nodes (low composite) → leaf node (via only the LOWEST-ranked nodes).
// Top-7 by composite do NOT connect to leaf. Only n1-n13 (the penalised ones) connect to leaf.
// Without inhibition: n1-n13 propagate to leaf at full strength from frontier.
// With inhibition: n1-n13 get penalised (multiplied by 0.85), so leaf activation is lower.
test('lateral inhibition limits frontier to top-7 per hop', () => {
  let g = emptyGraph('test', 'test');
  g = addNode(g, 'seed');
  for (let i = 1; i <= 20; i++) g = addNode(g, `n${i}`);
  g = addNode(g, 'leaf');

  const edges = [];
  for (let i = 1; i <= 20; i++) {
    // seed → n_i, composite = i/20 (n20=1.0 is strongest, n1=0.05 is weakest)
    edges.push({ source: 'seed', target: `n${i}`, weights: {}, composite: i / 20 });
  }
  // Only n8 (rank 8, just outside top-7) connects to leaf
  // n8 composite = 8/20 = 0.4 → will be penalised with inhibition, not penalised without
  edges.push({ source: 'n8', target: 'leaf', weights: {}, composite: 0.9 });
  g = { ...g, edges };

  const withInhibition = spreadingActivation(g, ['seed'], { maxHops: 2, decayPerHop: 1.0, threshold: 0.001, lateralInhibition: true });
  const withoutInhibition = spreadingActivation(g, ['seed'], { maxHops: 2, decayPerHop: 1.0, threshold: 0.001, lateralInhibition: false });

  const leafWith = withInhibition.get('leaf') ?? 0;
  const leafWithout = withoutInhibition.get('leaf') ?? 0;

  // With inhibition n8 is penalised (rank 8 > top 7), so its frontier strength going into
  // hop 2 is lower, meaning leaf activation is lower.
  assert.ok(leafWith < leafWithout, `Inhibited leaf (${leafWith}) should be < non-inhibited (${leafWithout})`);

  // Confirm top-7 nodes (n14-n20) are present in activation map
  for (let i = 14; i <= 20; i++) {
    assert.ok(withInhibition.has(`n${i}`), `n${i} should be in inhibited activation map`);
  }
});

// 2. addEdge creates bitemporal fields
test('addEdge sets valid_from and valid_until', () => {
  let g = emptyGraph('test', 'test');
  g = addNode(g, 'a');
  g = addNode(g, 'b');
  const before = Date.now();
  g = addEdge(g, 'a', 'b');
  const after = Date.now();

  const edge = g.edges.find(e => e.source === 'a' && e.target === 'b');
  assert.ok(edge, 'Edge should exist');
  assert.ok(edge.weights.valid_from, 'valid_from should be set');
  assert.strictEqual(edge.weights.valid_until, null, 'valid_until should be null');

  const ts = new Date(edge.weights.valid_from).getTime();
  assert.ok(ts >= before && ts <= after, 'valid_from should be near now');
});

// 3. updateConfidence increments n_confirms/n_contradicts, posterior mean correct
test('updateConfidence increments counts and posterior mean is correct', () => {
  let g = emptyGraph('test', 'test');
  g = addNode(g, 'a');
  g = addNode(g, 'b');
  g = addEdge(g, 'a', 'b');

  g = updateConfidence(g, 'a', 'b', 1);   // confirm
  g = updateConfidence(g, 'a', 'b', 1);   // confirm
  g = updateConfidence(g, 'a', 'b', -1);  // contradict

  const edge = g.edges.find(e => e.source === 'a' && e.target === 'b');
  const conf = edge.weights.confidence;
  assert.strictEqual(conf.n_confirms, 2, 'n_confirms should be 2');
  assert.strictEqual(conf.n_contradicts, 1, 'n_contradicts should be 1');

  // Posterior mean = (2 + 1) / (2 + 1 + 2) = 3/5 = 0.6
  const posterior = (conf.n_confirms + 1) / (conf.n_confirms + conf.n_contradicts + 2);
  assert.strictEqual(parseFloat(posterior.toFixed(4)), 0.6);
});

// 4. decayedVisitScore with degreeCentrality=1 produces slower decay
test('decayedVisitScore with degreeCentrality=1 decays slower than default', () => {
  const lastVisited = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
  const now = Date.now();
  const baseScore = decayedVisitScore(1.0, lastVisited, now, 30, 0);
  const centralScore = decayedVisitScore(1.0, lastVisited, now, 30, 1);
  // effectiveHalfLife = 30 * (1 + 0.5 * 1) = 45 days → less decay at 30 days
  assert.ok(centralScore > baseScore, `centralScore (${centralScore}) should be > baseScore (${baseScore})`);
  // At exactly halfLife days (30), base decays to 0.5; central decays to 0.5^(30/45) ≈ 0.63
  assert.ok(Math.abs(baseScore - 0.5) < 0.001, `baseScore should be ~0.5, got ${baseScore}`);
  assert.ok(centralScore > 0.5, 'centralScore should be > 0.5 at 30 days');
});

// 5a. enforceEdgeCap never evicts the protectedEdge even when its composite is 0.0
test('enforceEdgeCap does not evict protectedEdge even at composite 0.0', () => {
  let g = emptyGraph('test', 'test');
  g = addNode(g, 'hub');
  for (let i = 1; i <= 16; i++) g = addNode(g, `p${i}`);
  // 15 existing edges with composite 1..15, plus one new edge at composite 0.0
  const edges = [];
  for (let i = 1; i <= 15; i++) {
    edges.push({
      source: 'hub', target: `p${i}`,
      weights: { last_visited: new Date().toISOString() },
      composite: i,
    });
  }
  // The "newly added" edge has composite 0.0 — would normally be evicted first
  edges.push({ source: 'hub', target: 'p16', weights: { last_visited: null }, composite: 0.0 });
  g = { ...g, edges };

  g = enforceEdgeCap(g, 'hub', 15, { source: 'hub', target: 'p16' });

  const hubEdges = g.edges.filter(e => e.source === 'hub' || e.target === 'hub');
  assert.strictEqual(hubEdges.length, 15, `Expected 15 edges, got ${hubEdges.length}`);

  // p16 (composite 0.0, protected) must survive; p1 (composite 1, lowest non-protected) removed
  const hasP16 = g.edges.some(e => e.target === 'p16');
  const hasP1 = g.edges.some(e => e.target === 'p1');
  assert.strictEqual(hasP16, true, 'p16 (protected, composite 0.0) must not be evicted');
  assert.strictEqual(hasP1, false, 'p1 (lowest non-protected composite) should be removed');
});

// 5. enforceEdgeCap removes lowest-composite edge when node exceeds 15 edges
test('enforceEdgeCap removes lowest-composite edges to maintain cap', () => {
  let g = emptyGraph('test', 'test');
  // Add hub node and 17 targets
  g = addNode(g, 'hub');
  for (let i = 1; i <= 17; i++) g = addNode(g, `t${i}`);
  // Add edges manually with known composites to bypass cap during setup
  const edges = [];
  for (let i = 1; i <= 17; i++) {
    edges.push({
      source: 'hub',
      target: `t${i}`,
      weights: { co_change: 0, semantic: 0, _visit_raw: 0, visit_count: 0, last_visited: null, confidence: { n_confirms: 0, n_contradicts: 0 }, valid_from: new Date().toISOString(), valid_until: null },
      composite: i,  // t1 has lowest composite (1), t17 has highest (17)
    });
  }
  g = { ...g, edges };

  // Now enforce cap of 15
  g = enforceEdgeCap(g, 'hub', 15);

  const hubEdges = g.edges.filter(e => e.source === 'hub' || e.target === 'hub');
  assert.strictEqual(hubEdges.length, 15, `Expected 15 edges, got ${hubEdges.length}`);

  // Lowest composites (t1, t2) should have been removed
  const hasT1 = g.edges.some(e => e.target === 't1');
  const hasT2 = g.edges.some(e => e.target === 't2');
  assert.strictEqual(hasT1, false, 't1 (lowest composite) should be removed');
  assert.strictEqual(hasT2, false, 't2 (second lowest) should be removed');
});

// Part 1: effectiveImportance tests
test('effectiveImportance: zero access returns static as floor', () => {
  assert.strictEqual(effectiveImportance(0.3, 0), 0.3, 'no access → effective equals static');
  assert.strictEqual(effectiveImportance(0.9, 0), 0.9, 'hard-constraint static unchanged with no access');
});

test('effectiveImportance: frequent access raises effective above static', () => {
  const eff = effectiveImportance(0.2, 1.0);
  assert.ok(eff > 0.2, `frequently-accessed low-static (${eff}) should exceed static (0.2)`);
});

test('effectiveImportance: hard-constraint (static 0.9) stays near top regardless of access', () => {
  const eff = effectiveImportance(0.9, 1.0);
  assert.ok(eff >= 0.9, `hard-constraint effective (${eff}) must not fall below floor 0.9`);
  assert.ok(eff <= 1.0, 'must not exceed 1.0');
});

test('effectiveImportance: frequently-accessed beats never-accessed at same static importance', () => {
  const frequent = effectiveImportance(0.4, 0.8);
  const never = effectiveImportance(0.4, 0);
  assert.ok(frequent > never, `frequent (${frequent}) must rank above never-accessed (${never})`);
});

test('effectiveImportance: clamped to [0,1]', () => {
  assert.ok(effectiveImportance(1.0, 1.0) <= 1.0, 'max inputs stay at 1.0');
  assert.ok(effectiveImportance(0, 0) >= 0, 'zero inputs stay at 0');
  assert.ok(effectiveImportance(-0.5, 2.0) >= 0, 'negative static clamped to 0');
});

// Part 1: nodeAccessSignal tests
test('nodeAccessSignal: returns 0 for node with no edges', () => {
  const g = emptyGraph('test', 'test');
  assert.strictEqual(nodeAccessSignal(g.edges, 'orphan'), 0);
});

test('nodeAccessSignal: returns max visit_count of incident edges', () => {
  const edges = [
    { source: 'a', target: 'b', weights: { visit_count: 0.3 } },
    { source: 'c', target: 'a', weights: { visit_count: 0.7 } },
    { source: 'x', target: 'y', weights: { visit_count: 0.9 } }, // not incident to 'a'
  ];
  assert.strictEqual(nodeAccessSignal(edges, 'a'), 0.7, 'max incident visit_count for a');
  assert.strictEqual(nodeAccessSignal(edges, 'y'), 0.9, 'incident edge from x→y');
  assert.strictEqual(nodeAccessSignal(edges, 'z'), 0, 'no incident edges returns 0');
});
