#!/usr/bin/env node
// graph-query.js — query graph by keywords, return top-N nodes by composite score
// Usage: node tools/graph/graph-query.js <slug> [keywords...] [--top=N] [--json]
//        [--brain-path=PATH] [--mode=debugging|architecture|routine|incident]
//        [--spread] [--spread-hops=N] [--spread-decay=F]
//        [--primed=node1,node2,node3]
//        [--hot-stub]  — return only nodes with hot:true in frontmatter, then exit
//
// Brain roots (--brain-path accepts a directory OR a direct graph.json path — both work):
//   - project brains:        nexus/<slug>/                                (default, relative to cwd)
//   - agent/personal brains: ~/agent-memory/nexus/agent-brain/<agent>/    or  ~/agent-memory/nexus/personal-brain/
// These are two DIFFERENT roots — do not assume a project slug and an agent name resolve
// under the same parent directory.
//
// Fix 1: visit_count is decayed at query time (Ebbinghaus half-life 30 days)
// Fix 2: --mode adjusts composite weights for task context
// Fix 3: --spread enables multi-hop spreading activation to surface non-obvious connections
// Fix 6 (issue #36): --primed=node1,node2 adds priming_bonus to neighbors of active nodes

import { readFileSync, existsSync, appendFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

// Expand a leading ~ to the user's home directory.
// Handles ~, ~/path, and ~\path. Never mutates paths without a leading tilde.
// #155: guard non-string input — a bare `--brain-path` flag (no `=value`) parses to
// boolean `true`, which used to reach here and throw `p.startsWith is not a function`.
// Any non-string (undefined, true, number, ...) is returned as-is so callers can detect
// and report a clear "missing value" error instead of crashing on a low-level TypeError.
export function expandTilde(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}
import {
  readGraph,
  parseFrontmatter,
  WEIGHT_PROFILES,
  decayedVisitScore,
  spreadingActivation,
  recomputeComposite,
  needProbabilityScore,
  effectiveImportance,
  nodeAccessSignal,
} from './graph-lib.js';

// BM25 keyword scoring.
// terms: string[], docContent: string, df: Map<string,number>, N: number, avgdl: number
// Returns raw BM25 score (not normalized).
export function computeBM25(terms, docContent, df, N, avgdl) {
  if (!terms || terms.length === 0) return 0;
  const k1 = 1.5;
  const b = 0.75;
  const words = docContent.toLowerCase().split(/\s+/);
  const docLen = words.length || 1;

  let score = 0;
  for (const term of terms) {
    const t = term.toLowerCase();
    const tf = words.filter(w => w === t).length;
    const dfTerm = df.get(t) || 0;
    const idf = Math.log((N - dfTerm + 0.5) / (dfTerm + 0.5) + 1);
    score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgdl));
  }
  return score;
}

import { isMainModule } from '../is-main.js';

function main() {
  const args = process.argv.slice(2);
  const flags = {};
  const positional = [];
  for (const a of args) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v ?? true;
    } else {
      positional.push(a);
    }
  }

  const [slug, ...keywords] = positional;
  if (!slug) {
    console.error('Usage: graph-query.js <slug> [keywords...] [--top=N] [--json] [--brain-path=PATH]');
    console.error('       [--mode=debugging|architecture|routine|incident] [--spread]');
    console.error('       [--hot-stub]');
    console.error('');
    console.error('--brain-path accepts EITHER a brain directory (containing graph.json + nodes/)');
    console.error('OR a direct path to a graph.json file — both forms resolve to the same brain.');
    console.error('There are two different brain roots in this repo, both queryable this way:');
    console.error('  - project brains:  nexus/<slug>/                      (relative to cwd, default when --brain-path omitted)');
    console.error('  - agent/personal brains: ~/agent-memory/nexus/agent-brain/<agent>/  or  ~/agent-memory/nexus/personal-brain/');
    process.exit(1);
  }

  if ('brain-path' in flags && typeof flags['brain-path'] !== 'string') {
    console.error('--brain-path requires a value, e.g. --brain-path=~/agent-memory/nexus/personal-brain');
    process.exit(1);
  }

  const topN = parseInt(flags.top || '10');
  const jsonOut = !!flags.json;
  const mode = flags.mode || 'default';
  const useSpread = !!flags.spread;
  const spreadHops = parseInt(flags['spread-hops'] || '3');
  const spreadDecay = parseFloat(flags['spread-decay'] || '0.5');
  const hotStub = !!flags['hot-stub'];
  const recordAccess = !!flags['record-access'];

  // Fix 6 (issue #36): Working memory priming.
  const primedNodes = flags.primed
    ? new Set(String(flags.primed).split(',').map(s => s.trim()).filter(Boolean))
    : new Set();
  const PRIMING_BONUS = 0.15;

  // Validate mode (skip for hot-stub since we exit before scoring)
  if (!hotStub && !WEIGHT_PROFILES[mode]) {
    console.error(`Unknown mode: ${mode}. Valid: ${Object.keys(WEIGHT_PROFILES).join(', ')}`);
    process.exit(1);
  }

  // #155: --brain-path may point at either the brain DIRECTORY (containing graph.json)
  // or directly at a graph.json FILE — accept both so callers don't need to know which
  // convention a given brain root uses.
  let nexusDir = flags['brain-path']
    ? resolve(expandTilde(flags['brain-path']))
    : join(process.cwd(), 'nexus', slug);
  if (basename(nexusDir) === 'graph.json') {
    nexusDir = dirname(nexusDir);
  } else if (existsSync(nexusDir)) {
    try {
      if (statSync(nexusDir).isFile()) nexusDir = dirname(nexusDir);
    } catch { /* fall through — treated as directory below */ }
  }

  const graphPath = join(nexusDir, 'graph.json');
  if (!existsSync(graphPath)) {
    console.error(`No graph at ${graphPath}. Run graph-init first.`);
    process.exit(1);
  }

  const graph = readGraph(graphPath);
  const nodesDir = join(nexusDir, 'nodes');
  const now = Date.now();

  // --hot-stub mode: return nodes with hot:true in frontmatter, then exit
  if (hotStub) {
    const hotNodes = [];
    for (const nodeId of graph.nodes) {
      const nodePath = join(nodesDir, `${nodeId}.md`);
      if (!existsSync(nodePath)) continue;
      const { frontmatter } = parseFrontmatter(readFileSync(nodePath, 'utf8'));
      if (frontmatter.hot === true) {
        hotNodes.push(nodeId);
      }
    }
    if (jsonOut) {
      console.log(JSON.stringify(hotNodes));
    } else {
      for (const nodeId of hotNodes) {
        console.log(nodeId);
      }
    }
    process.exit(0);
  }

  // Adaptive importance: blend section-assigned static importance with learned access signal
  // (raw normalised visit_count, recency-free) so frequently-recalled low-importance facts rise.
  // Skip superseded nodes to avoid injecting conflicting information.
  const importanceMap = new Map();
  const supersededNodes = new Set();
  for (const nodeId of graph.nodes) {
    const nodePath = join(nodesDir, `${nodeId}.md`);
    if (!existsSync(nodePath)) continue;
    const { frontmatter } = parseFrontmatter(readFileSync(nodePath, 'utf8'));
    if (frontmatter.superseded_by) {
      supersededNodes.add(nodeId);
      continue;
    }
    const staticImp = parseFloat(frontmatter.importance ?? frontmatter.salience ?? 0);
    const s = Number.isFinite(staticImp) ? staticImp : 0;
    const accessSig = nodeAccessSignal(graph.edges, nodeId);
    importanceMap.set(nodeId, effectiveImportance(s, accessSig));
  }

  // Fix 1: Build a time-decayed version of the graph for scoring.
  function effectiveComposite(edge) {
    const decayed = decayedVisitScore(
      edge.weights.visit_count,
      edge.weights.last_visited,
      now
    );
    return recomputeComposite(
      { ...edge.weights, visit_count: decayed },
      mode
    );
  }

  // Fix 6: Build primed neighbor set
  const primedNeighbors = new Set();
  if (primedNodes.size > 0) {
    for (const edge of graph.edges) {
      if (primedNodes.has(edge.source)) primedNeighbors.add(edge.target);
      if (primedNodes.has(edge.target)) primedNeighbors.add(edge.source);
    }
  }

  // Pre-load all node content for BM25 IDF calculation when keywords are present
  let contentCache = null;
  let dfMap = null;
  let bm25Avgdl = 1;

  if (keywords.length > 0) {
    contentCache = new Map();
    for (const nodeId of graph.nodes) {
      const nodePath = join(nodesDir, `${nodeId}.md`);
      if (existsSync(nodePath)) {
        const raw = readFileSync(nodePath, 'utf8');
        const { frontmatter, body } = parseFrontmatter(raw);
        const haystack = [
          ...(frontmatter.relevance_keywords || []),
          nodeId,
          body,
        ].join(' ');
        contentCache.set(nodeId, haystack);
      }
    }

    dfMap = new Map();
    let totalWords = 0;
    const cacheN = contentCache.size;
    for (const [, content] of contentCache) {
      totalWords += content.toLowerCase().split(/\s+/).length;
      for (const kw of keywords) {
        const t = kw.toLowerCase();
        if (content.toLowerCase().includes(t)) {
          dfMap.set(t, (dfMap.get(t) || 0) + 1);
        }
      }
    }
    bm25Avgdl = cacheN > 0 ? totalWords / cacheN : 1;
  }

  const MAX_BM25 = 10.0;

  const scored = graph.nodes
    .filter(nodeId => !supersededNodes.has(nodeId)) // Skip superseded nodes
    .map(nodeId => {
      const rawEdgeScore = graph.edges
        .filter(e => e.source === nodeId || e.target === nodeId)
        .reduce((max, e) => Math.max(max, effectiveComposite(e)), 0);

      const primed = primedNeighbors.has(nodeId);
      const edgeScore = primed ? Math.min(1.0, rawEdgeScore + PRIMING_BONUS) : rawEdgeScore;

      let keywordScore = 0;
      if (keywords.length > 0 && contentCache) {
        const content = contentCache.get(nodeId);
        if (content) {
          const cacheN = contentCache.size;
          const raw = computeBM25(keywords, content, dfMap, cacheN, bm25Avgdl);
          keywordScore = Math.min(1.0, raw / (keywords.length * MAX_BM25));
        }
      }

      const base = keywords.length > 0
        ? edgeScore * 0.4 + keywordScore * 0.6
        : edgeScore;
      const score = needProbabilityScore(base, importanceMap.get(nodeId));

      return { nodeId, score, edgeScore, keywordScore, primed };
    });

  const directResults = scored
    .filter(r => r.score > 0 || keywords.length === 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  // Reconsolidation-on-access: append accessed node IDs to an append-only log (no graph
  // rewrite on the read path → safe under parallel queries). memory-reconsolidate folds it in.
  if (recordAccess && directResults.length > 0) {
    const logLine = JSON.stringify({ ts: new Date().toISOString(), nodes: directResults.map(r => r.nodeId) }) + '\n';
    try { appendFileSync(join(nexusDir, 'visits.log'), logLine, 'utf8'); } catch { /* non-fatal */ }
  }

  // Fix 3: Spreading activation
  let spreadResults = [];
  if (useSpread && directResults.length > 0) {
    const seedNodes = directResults.slice(0, 5).map(r => r.nodeId);
    const decayedGraph = {
      ...graph,
      edges: graph.edges.map(e => ({
        ...e,
        composite: effectiveComposite(e),
      })),
    };
    const activation = spreadingActivation(decayedGraph, seedNodes, {
      maxHops: spreadHops,
      decayPerHop: spreadDecay,
      threshold: 0.05,
    });
    const directIds = new Set(directResults.map(r => r.nodeId));
    spreadResults = Array.from(activation.entries())
      .filter(([nodeId]) => !directIds.has(nodeId))
      .map(([nodeId, activation_strength]) => ({ nodeId, activation_strength }))
      .sort((a, b) => b.activation_strength - a.activation_strength)
      .slice(0, topN);
  }

  if (jsonOut) {
    const out = { mode, direct: directResults };
    if (useSpread) out.spread = spreadResults;
    console.log(JSON.stringify(out, null, 2));
  } else {
    const modeLabel = mode !== 'default' ? ` [mode: ${mode}]` : '';
    if (directResults.length === 0) {
      console.log(`No results for: ${keywords.join(', ')}`);
    } else {
      console.log(`Top ${directResults.length} nodes in [${slug}]${modeLabel} for: ${keywords.join(', ') || '(all)'}\n`);
      for (const r of directResults) {
        const primedTag = r.primed ? ' [primed]' : '';
        console.log(`  ${r.nodeId.padEnd(55)} score=${r.score}${primedTag}`);
      }
    }
    if (useSpread && spreadResults.length > 0) {
      console.log(`\nSpreading activation (${spreadHops} hops) — non-obvious connections:\n`);
      for (const r of spreadResults) {
        console.log(`  ${r.nodeId.padEnd(55)} activation=${r.activation_strength}`);
      }
    }
  }
}

if (isMainModule(import.meta.url)) main();
