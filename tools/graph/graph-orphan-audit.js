#!/usr/bin/env node
// graph-orphan-audit.js — report nodes that no edge touches, per brain.
//
// An orphan node is unreachable by graph-query.js (it walks edges), so it is stored but never
// recalled: the fact is on disk and invisible to every agent. graph-lib's pruneOrphanedEdges()
// covers the opposite direction (edges pointing at nodes that no longer exist) — nothing covered
// orphan *nodes* until this.
//
// Read-only on purpose. Fixing an orphan means either deleting a stale node or adding a real
// edge, and both are judgement calls: an auto-connect pass invents edges that then outrank true
// ones in spreading activation. graph.json is generated, so any fix belongs in graph-init.js /
// graph-weight.js, not in a script that rewrites it in place.
//
// Usage:
//   node tools/graph/graph-orphan-audit.js                       # every brain under ~/agent-memory/nexus
//   node tools/graph/graph-orphan-audit.js --brain-path=PATH     # one brain
//   node tools/graph/graph-orphan-audit.js --limit=50            # orphans listed per brain (default 20)

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readGraph, agentMemoryRoot } from './graph-lib.js';
import { parseFlagsOrExit } from '../cli-args.js';
import { isMainModule } from '../is-main.js';

const USAGE = `Usage: node tools/graph/graph-orphan-audit.js [--brain-path=PATH] [--limit=N]

  --brain-path=PATH  audit a single brain directory (one holding graph.json)
  --limit=N          orphan ids to list per brain (default 20)

Read-only: reports orphan nodes, changes nothing.`;

// Pure: node ids that appear in graph.nodes but in no edge (either endpoint).
export function findOrphans(graph) {
  const linked = new Set();
  for (const edge of (graph.edges || [])) {
    if (edge?.source) linked.add(edge.source);
    if (edge?.target) linked.add(edge.target);
  }
  return (graph.nodes || []).filter(n => !linked.has(n)).sort();
}

// Every directory at or under `root` that holds a graph.json. No hardcoded brain names — brains
// are added by graph-init.js / agent-brain-init.js at will, so a fixed list goes stale silently.
export function discoverBrains(root) {
  const found = [];
  if (!existsSync(root)) return found;

  const walk = (dir) => {
    if (existsSync(join(dir, 'graph.json'))) found.push(dir);
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      // `nodes/` holds the .md files, never a nested brain; dotdirs are .git and friends.
      if (!e.isDirectory() || e.name === 'nodes' || e.name.startsWith('.')) continue;
      walk(join(dir, e.name));
    }
  };

  walk(root);
  return found.sort();
}

function expandTilde(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

function main() {
  const flags = parseFlagsOrExit(process.argv.slice(2), {
    usage: USAGE,
    allowed: ['brain-path', 'limit'],
  });
  const limit = Number.parseInt(flags.limit, 10) > 0 ? Number.parseInt(flags.limit, 10) : 20;
  const nexus = join(agentMemoryRoot(), 'nexus');

  const brains = flags['brain-path']
    ? [resolve(expandTilde(String(flags['brain-path'])))]
    : discoverBrains(nexus);

  if (brains.length === 0) {
    console.error(`No graph.json found under ${nexus}. Run graph-init first.`);
    process.exit(1);
  }

  let totalNodes = 0;
  let totalOrphans = 0;

  for (const brain of brains) {
    const graphPath = join(brain, 'graph.json');
    let graph;
    try { graph = readGraph(graphPath); }
    catch (e) { console.error(`${brain}: unreadable graph.json (${e.message})`); continue; }

    const orphans = findOrphans(graph);
    const nodeCount = (graph.nodes || []).length;
    totalNodes += nodeCount;
    totalOrphans += orphans.length;

    const label = brain.startsWith(nexus) ? brain.slice(nexus.length + 1) || '.' : brain;
    console.log(`${label}: ${nodeCount} nodes, ${(graph.edges || []).length} edges, ${orphans.length} orphans`);
    for (const id of orphans.slice(0, limit)) console.log(`  - ${id}`);
    if (orphans.length > limit) console.log(`  ... and ${orphans.length - limit} more`);
  }

  const pct = totalNodes ? Math.round((totalOrphans / totalNodes) * 100) : 0;
  console.log(`\n${totalOrphans}/${totalNodes} nodes orphaned (${pct}%) across ${brains.length} brain(s)`);
}

if (isMainModule(import.meta.url)) main();
