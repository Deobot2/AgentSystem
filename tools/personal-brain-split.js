#!/usr/bin/env node
// personal-brain-split.js — parse user-brain.md into discrete graph nodes
// Usage: node tools/personal-brain-split.js [--dry-run]
// Exports splitPersonalBrain() for reuse by brain-remember.js and memory-maintenance.js

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { agentMemoryRoot, readGraph, writeGraph, addNode, addEdge, emptyGraph, parseFrontmatter } from './graph/graph-lib.js';
import { parseFlagsOrExit } from './cli-args.js';
import { isMainModule } from './is-main.js';

const USAGE = 'Usage: node tools/personal-brain-split.js [--dry-run] [--help]';

// Extract fields from existing node file that downstream steps own (salience, connections).
// Returns {} if file does not exist or has no frontmatter.
function readPreservedFields(nodeFile) {
  if (!existsSync(nodeFile)) return {};
  try {
    const raw = readFileSync(nodeFile, 'utf8');
    const { frontmatter } = parseFrontmatter(raw);
    const out = {};
    if (frontmatter.salience !== undefined) out.salience = frontmatter.salience;
    if (frontmatter.connections !== undefined) out.connections = frontmatter.connections;
    return out;
  } catch { return {}; }
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .join('-');
}

// Importance at encode (need-probability input). Hard constraints and identity
// matter most for recall; session notes least. Range [0,1].
export function sectionImportance(section) {
  const s = section.toLowerCase();
  if (s.includes("don't want") || s.includes('dont want')) return 0.9;
  if (s.includes('insight') || s.includes('learned')) return 0.8;
  if (s.includes('who i am') || s.includes('identity')) return 0.7;
  if (s.includes('goal') || s.includes('vision')) return 0.7;
  if (s.includes('preference') || s.includes('work') || s.includes('code') || s.includes('technical')) return 0.6;
  if (s.includes('session') || s.includes('note')) return 0.3;
  return 0.5;
}

function extractKeywords(text) {
  return text
    .replace(/^[-*]\s*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 3);
}

// Unfilled template placeholder bullets (e.g. "[Add your preferences here]",
// "[Goal 1]", "[e.g. React, Postgres]") — never real user facts, must not become nodes.
const PLACEHOLDER_RE = /\[\s*(add your|e\.g\.|your |goal\s*\d|project name|list your)/i;

// Parse user-brain.md → { section, text } candidates (one per bullet).
export function parseBrainCandidates(raw) {
  const candidates = [];
  let currentSection = 'General';
  for (const line of raw.split('\n')) {
    const headerMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (headerMatch) { currentSection = headerMatch[1].trim(); continue; }
    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      const text = bulletMatch[1].trim();
      // Skip superseded facts (struck-through by memory-reconcile UPDATE) and
      // unfilled template placeholders (bracketed instructional text).
      if (text && !text.startsWith('~~') && !PLACEHOLDER_RE.test(text)) {
        candidates.push({ section: currentSection, text: `- ${text}` });
      }
    }
  }
  return candidates;
}

export function splitPersonalBrain({ dryRun = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const brainDir = join(agentMemoryRoot(), 'nexus', 'personal-brain');
  const brainPath = join(brainDir, 'user-brain.md');
  const nodesDir = join(brainDir, 'nodes');
  const graphPath = join(brainDir, 'graph.json');

  if (!existsSync(brainPath)) {
    return { ok: false, message: 'user-brain.md not found — nothing to split', nodesCreated: 0, edgesAdded: 0 };
  }

  const raw = readFileSync(brainPath, 'utf8');
  const candidates = parseBrainCandidates(raw);

  let graph = existsSync(graphPath) ? readGraph(graphPath) : emptyGraph('agent', 'personal-brain');
  const edgesBefore = graph.edges.length;
  let nodesCreated = 0;
  let nodesExisting = 0;
  const nodeIds = [];
  const nodeKeywords = new Map();
  const sectionLastNode = new Map();

  for (const { section, text } of candidates) {
    const id = slugify(text.replace(/^[-*]\s*/, ''));
    if (!id) continue;

    const keywords = extractKeywords(text);
    const importance = sectionImportance(section);
    const nodeFile = join(nodesDir, `${id}.md`);

    // Carry forward fields owned by downstream steps so they survive re-split.
    const preserved = readPreservedFields(nodeFile);
    const salienceLine = preserved.salience !== undefined ? `\nsalience: ${preserved.salience}` : '';
    const connectionsLine = preserved.connections !== undefined ? `\nconnections: ${preserved.connections}` : '';

    const nodeContent = `---
id: ${id}
type: user-fact
brain: personal-brain
created: ${today}
source_section: ${section}
relevance_keywords: [${keywords.join(', ')}]
importance: ${importance}
hot: true${salienceLine}${connectionsLine}
---

${text}
`;

    const alreadyExisted = existsSync(nodeFile);
    if (!dryRun) {
      mkdirSync(nodesDir, { recursive: true });
      writeFileSync(nodeFile, nodeContent, 'utf8');
    }
    if (alreadyExisted) nodesExisting++; else nodesCreated++;

    if (!graph.nodes.includes(id)) graph = addNode(graph, id);

    const prevInSection = sectionLastNode.get(section);
    if (prevInSection && prevInSection !== id) graph = addEdge(graph, prevInSection, id);
    sectionLastNode.set(section, id);

    nodeIds.push(id);
    nodeKeywords.set(id, keywords);
  }

  // Semantic edges: connect nodes sharing 2+ keywords
  for (let i = 0; i < nodeIds.length; i++) {
    for (let j = i + 1; j < nodeIds.length; j++) {
      const a = nodeIds[i], b = nodeIds[j];
      if (a === b) continue;
      const ka = nodeKeywords.get(a) || [];
      const kb = nodeKeywords.get(b) || [];
      if (ka.filter(k => kb.includes(k)).length >= 2) graph = addEdge(graph, a, b);
    }
  }

  const edgesAdded = graph.edges.length - edgesBefore;
  if (!dryRun) writeGraph(graphPath, graph);
  return { ok: true, nodesCreated, nodesExisting, edgesAdded, candidateCount: candidates.length };
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  const flags = parseFlagsOrExit(process.argv.slice(2), { usage: USAGE, allowed: ['dry-run'] });
  const dryRun = !!flags['dry-run'];
  const r = splitPersonalBrain({ dryRun });
  if (!r.ok) { console.log(`personal-brain-split: ${r.message}`); process.exit(0); }
  if (dryRun) console.log(`[dry-run] would split user-brain.md → ${r.candidateCount} nodes (${r.nodesCreated} new, ${r.nodesExisting} existing), ~${r.edgesAdded} edges`);
  else console.log(`split user-brain.md → ${r.nodesCreated} nodes created, ${r.nodesExisting} already existed (updated), ${r.edgesAdded} edges added`);
}
