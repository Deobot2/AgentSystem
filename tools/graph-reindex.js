#!/usr/bin/env node
// graph-reindex.js — safely rebuild graph.json from nodes/*.md, without touching any node file.
//
// #252: brain-join.sh and brain-sync.js both used to point callers at `graph.js/graph-init.js` for
// this step, and graph-init.js is the wrong tool — it SCAFFOLDS a repo brain: it mines `git log`
// in the target directory, writes commit/hotfile/file node .md files, and rewrites INDEX.md.
// Pointed at an agent-memory brain (which has no git history of its own project) it would mine the
// CURRENT working directory's git history and author bogus nodes into someone's memory.
//
// What brain-join.sh and brain-sync.js actually need after a merge that took the central
// graph.json (or after a host accumulated node files that were never indexed) is an index rebuild:
// walk existing `nodes/*.md`, add any id missing from `graph.json`, derive edges from each node's
// `connections:` frontmatter wikilinks, and write ONLY graph.json. Never touch a node file.
//
// Usage:
//   node tools/graph-reindex.js                        # sweep every brain under agentMemoryRoot()/nexus
//   node tools/graph-reindex.js --brain-path=PATH       # reindex a single brain directory
//   node tools/graph-reindex.js <brain-path>            # same, as a positional arg
//   node tools/graph-reindex.js --check                 # exit 1 if any brain has un-indexed nodes
//
// Follows the pure-functions-separate-from-CLI pattern in tools/graph/graph-orphan-audit.js so the
// logic is unit-testable without spawning a subprocess.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readGraph, writeGraph, emptyGraph, addNode, addEdge, parseFrontmatter, agentMemoryRoot } from './graph/graph-lib.js';
import { parseFlagsOrExit } from './cli-args.js';
import { isMainModule } from './is-main.js';

const USAGE = `Usage: node tools/graph-reindex.js [brain-path] [--brain-path=PATH] [--check]

  brain-path         reindex a single brain directory (positional, same as --brain-path)
  --brain-path=PATH  reindex a single brain directory (one that holds, or should hold, graph.json)
  --check            exit 1 if any nodes/*.md file is missing from graph.json; exit 0 if clean
                      (no positional/--brain-path: sweeps every brain under agentMemoryRoot()/nexus)

Writes ONLY graph.json. Never touches a node file. Safe to run repeatedly.`;

function expandTilde(p) {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

// Every nodes/*.md id under a brain dir, in file order.
function listNodeIds(nodesDir) {
  if (!existsSync(nodesDir)) return [];
  return readdirSync(nodesDir)
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace(/\.md$/, ''));
}

// Wikilink targets (`[[id]]`) referenced by a node's `connections:` frontmatter, restricted to
// ids that actually exist as a node file in this brain (a dangling link is not an edge to add).
function connectionTargets(nodesDir, nodeId) {
  const filePath = join(nodesDir, `${nodeId}.md`);
  let content;
  try { content = readFileSync(filePath, 'utf8'); }
  catch { return []; }
  const { frontmatter } = parseFrontmatter(content);
  const raw = frontmatter.connections;
  const links = (Array.isArray(raw) ? raw.join(',') : String(raw ?? '')).match(/\[\[([^\]]+)\]\]/g) || [];
  return links
    .map(l => l.slice(2, -2))
    .filter(target => existsSync(join(nodesDir, `${target}.md`)));
}

// Pure: given a brain dir's existing graph and its nodes/*.md files, return the set of node ids
// present on disk but absent from graph.nodes. This is the drift --check reports.
export function findMissingNodes(graph, nodesDir) {
  const have = new Set(graph.nodes || []);
  return listNodeIds(nodesDir).filter(id => !have.has(id));
}

// Reindex one brain directory: add any nodes/*.md missing from graph.json, derive edges from
// `connections:` frontmatter, write graph.json. Returns { graph, added, edgesAdded }. Never writes
// to nodesDir. `brainDir` must be the directory that holds (or should hold) graph.json.
export function reindexBrain(brainDir) {
  const nodesDir = join(brainDir, 'nodes');
  const graphPath = join(brainDir, 'graph.json');

  let graph = existsSync(graphPath) ? readGraph(graphPath) : emptyGraph('unknown', undefined);
  const have = new Set(graph.nodes || []);
  const added = [];

  for (const id of listNodeIds(nodesDir)) {
    if (have.has(id)) continue;
    graph = addNode(graph, id);
    have.add(id);
    added.push(id);
  }

  let edgesAdded = 0;
  for (const id of listNodeIds(nodesDir)) {
    for (const target of connectionTargets(nodesDir, id)) {
      const before = graph.edges.length;
      graph = addEdge(graph, id, target);
      if (graph.edges.length > before) edgesAdded++;
    }
  }

  writeGraph(graphPath, graph);
  return { graph, added, edgesAdded };
}

// Discover every brain worth reindexing under agentMemoryRoot()/nexus: personal-brain and each
// nexus/agent-brain/<agent>/. Matches what brain-join.sh and brain-sync.js need after a merge —
// no hardcoded agent list, so a newly added agent brain is picked up automatically.
export function discoverBrains(root) {
  const found = [];
  const personal = join(root, 'personal-brain');
  if (existsSync(personal)) found.push(personal);

  const agentBrainRoot = join(root, 'agent-brain');
  if (existsSync(agentBrainRoot)) {
    for (const entry of readdirSync(agentBrainRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) found.push(join(agentBrainRoot, entry.name));
    }
  }
  return found.sort();
}

function main() {
  const argv = process.argv.slice(2);
  const positional = argv.filter(a => a !== '-h' && a !== '--help' && !a.startsWith('--'));
  const flags = parseFlagsOrExit(argv.filter(a => a === '-h' || a === '--help' || a.startsWith('--')), {
    usage: USAGE,
    allowed: ['brain-path', 'check'],
  });

  const explicitBrain = flags['brain-path']
    ? resolve(expandTilde(String(flags['brain-path'])))
    : (positional[0] ? resolve(expandTilde(positional[0])) : null);

  const nexus = join(agentMemoryRoot(), 'nexus');
  const brains = explicitBrain ? [explicitBrain] : discoverBrains(nexus);

  if (brains.length === 0) {
    console.error(`No brains found under ${nexus}. Pass --brain-path=PATH to target one directly.`);
    process.exit(1);
  }

  if (flags.check) {
    let anyMissing = false;
    for (const brain of brains) {
      const graphPath = join(brain, 'graph.json');
      const graph = existsSync(graphPath) ? readGraph(graphPath) : emptyGraph('unknown', undefined);
      const missing = findMissingNodes(graph, join(brain, 'nodes'));
      if (missing.length) {
        anyMissing = true;
        console.log(`${brain}: ${missing.length} node(s) missing from graph.json`);
        for (const id of missing) console.log(`  - ${id}`);
      } else {
        console.log(`${brain}: clean (all nodes indexed)`);
      }
    }
    process.exit(anyMissing ? 1 : 0);
  }

  for (const brain of brains) {
    const { added, edgesAdded } = reindexBrain(brain);
    console.log(`${brain}: +${added.length} node(s), +${edgesAdded} edge(s)`);
  }
}

if (isMainModule(import.meta.url)) main();
