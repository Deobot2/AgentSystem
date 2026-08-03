#!/usr/bin/env node
// memory-reconsolidate.js — fold the access log (visits.log) into the graph.
// Reconsolidation: recalled memories are strengthened. graph-query --record-access appends
// accessed node IDs off the read path; this folds them in with a single graph write, then
// truncates the log. Run from maintenance, not the hot path.
// Usage: node tools/memory-reconsolidate.js --brain-path=<dir with graph.json + visits.log>

import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { readGraph, writeGraph, updateVisitCount } from './graph/graph-lib.js';
import { isMainModule } from './is-main.js';

// Pure: bump visit_count on every edge incident to an accessed node.
export function foldVisits(graph, accessedNodeIds) {
  let g = graph;
  for (const nodeId of accessedNodeIds) {
    for (const e of g.edges) {
      if (e.source === nodeId || e.target === nodeId) {
        g = updateVisitCount(g, e.source, e.target);
      }
    }
  }
  return g;
}

export function reconsolidate(brainPath) {
  const dir = resolve(brainPath);
  const graphPath = join(dir, 'graph.json');
  const logPath = join(dir, 'visits.log');
  if (!existsSync(graphPath)) return { ok: false, message: `no graph at ${graphPath}` };
  if (!existsSync(logPath)) return { ok: true, folded: 0, message: 'no visits.log — nothing to fold' };

  const accessed = [];
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const entry = JSON.parse(line); if (Array.isArray(entry.nodes)) accessed.push(...entry.nodes); }
    catch { /* skip malformed line */ }
  }
  if (accessed.length === 0) { rmSync(logPath, { force: true }); return { ok: true, folded: 0 }; }

  const graph = readGraph(graphPath);
  const updated = foldVisits(graph, accessed);
  writeGraph(graphPath, updated);
  rmSync(logPath, { force: true });
  return { ok: true, folded: accessed.length, uniqueNodes: new Set(accessed).size };
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  const arg = process.argv.slice(2).find(a => a.startsWith('--brain-path='));
  if (!arg) { console.error('Usage: memory-reconsolidate.js --brain-path=<dir>'); process.exit(1); }
  const r = reconsolidate(arg.split('=')[1]);
  if (!r.ok) { console.error(`memory-reconsolidate: ${r.message}`); process.exit(1); }
  console.log(`reconsolidate: folded ${r.folded} accesses${r.uniqueNodes ? ` across ${r.uniqueNodes} nodes` : ''}`);
}
