#!/usr/bin/env node
// wikilink-sync.js — sync graph.json edges → node frontmatter [[wikilink]] connections
// Obsidian reads frontmatter `connections: [[nodeA]], [[nodeB]]` to build its graph view.
// graph.json is the source of truth; this tool propagates edges into node files idempotently.
//
// Usage: node tools/graph/wikilink-sync.js [--brain-path=PATH] [--dry-run]
//        Default brain-path: ~/agent-memory/nexus/personal-brain

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readGraph } from './graph-lib.js';
import { isMainModule } from '../is-main.js';

// Re-use tilde expansion (same logic as graph-query.js, kept local to avoid circular deps).
function expandTilde(p) {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

// Pure: build a Map<nodeId, Set<neighborId>> from graph edges (undirected).
// Both source→target and target→source are recorded so Obsidian sees all links.
export function buildWikilinkMap(graph) {
  const map = new Map();
  for (const id of (graph.nodes || [])) {
    if (!map.has(id)) map.set(id, new Set());
  }
  for (const edge of (graph.edges || [])) {
    const { source, target } = edge;
    if (!source || !target || source === target) continue;
    if (!map.has(source)) map.set(source, new Set());
    if (!map.has(target)) map.set(target, new Set());
    map.get(source).add(target);
    map.get(target).add(source); // undirected
  }
  return map;
}

// Pure: insert or replace the `connections:` line in a frontmatter block.
// If neighbors is empty, remove the connections line (avoid `connections: []` noise).
// Returns { updated: boolean, content: string }.
export function patchConnections(rawContent, neighbors) {
  const sorted = [...neighbors].sort();
  const wikilinks = sorted.map(n => `[[${n}]]`).join(', ');

  // Detect frontmatter block (must start with ---)
  if (!rawContent.startsWith('---')) {
    return { updated: false, content: rawContent };
  }

  const fmEnd = rawContent.indexOf('\n---', 3);
  if (fmEnd === -1) return { updated: false, content: rawContent };

  const front = rawContent.slice(0, fmEnd);
  const rest  = rawContent.slice(fmEnd);

  // Check if connections line already exists
  const existingMatch = front.match(/^connections:.*$/m);
  const existingLine  = existingMatch ? existingMatch[0] : null;

  if (sorted.length === 0) {
    // Remove connections line if present; otherwise no change
    if (!existingLine) return { updated: false, content: rawContent };
    const removed = front.replace(/\nconnections:.*/, '');
    return { updated: true, content: removed + rest };
  }

  const newLine = `connections: ${wikilinks}`;
  if (existingLine === newLine) return { updated: false, content: rawContent };

  let newFront;
  if (existingLine) {
    newFront = front.replace(/^connections:.*$/m, newLine);
  } else {
    // Append before closing ---
    newFront = front + `\nconnections: ${wikilinks}`;
  }

  return { updated: true, content: newFront + rest };
}

// Walk nodesDir, applying wikilinkMap to each node file.
// Returns { total, updated, skipped }.
export function applyWikilinkMap(wikilinkMap, nodesDir, { dryRun = false } = {}) {
  const stats = { total: 0, updated: 0, skipped: 0 };
  if (!existsSync(nodesDir)) return stats;

  let files;
  try { files = readdirSync(nodesDir).filter(f => f.endsWith('.md')); }
  catch { return stats; }

  for (const file of files) {
    const nodeId = file.slice(0, -3); // strip .md
    stats.total++;
    const neighbors = wikilinkMap.get(nodeId) || new Set();
    const filePath = join(nodesDir, file);

    let raw;
    try { raw = readFileSync(filePath, 'utf8'); }
    catch { stats.skipped++; continue; }

    const { updated, content } = patchConnections(raw, neighbors);
    if (!updated) { stats.skipped++; continue; }

    if (!dryRun) {
      try { writeFileSync(filePath, content, 'utf8'); }
      catch { stats.skipped++; continue; }
    }
    stats.updated++;
  }

  return stats;
}

// ── CLI entry ─────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const flags = {};
  for (const a of args) {
    if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v ?? true; }
  }

  const dryRun = !!flags['dry-run'];
  const brainPath = flags['brain-path']
    ? resolve(expandTilde(flags['brain-path']))
    : join(homedir(), 'agent-memory', 'nexus', 'personal-brain');

  const graphPath = join(brainPath, 'graph.json');
  const nodesDir  = join(brainPath, 'nodes');

  if (!existsSync(graphPath)) {
    console.error(`No graph.json at ${graphPath}. Run graph-init first.`);
    process.exit(1);
  }

  const graph = readGraph(graphPath);
  const wikilinkMap = buildWikilinkMap(graph);
  const stats = applyWikilinkMap(wikilinkMap, nodesDir, { dryRun });

  if (dryRun) {
    console.log(`[dry-run] wikilink-sync: ${stats.total} nodes, ${stats.updated} would be updated, ${stats.skipped} unchanged`);
  } else {
    console.log(`wikilink-sync: ${stats.total} nodes, ${stats.updated} updated, ${stats.skipped} unchanged`);
  }
}

if (isMainModule(import.meta.url)) main();
