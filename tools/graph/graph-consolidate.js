#!/usr/bin/env node
// graph-consolidate.js — session-end memory consolidation (Fix 5, issue #34)
// Distills session outcomes into reasoning bank, flags anti-patterns, prunes stale edges.
//
// Usage: node tools/graph/graph-consolidate.js <slug> [--brain-path=PATH]
//        [--agent-brain-path=PATH] [--dry-run] [--since=ISO_DATE]
//
// What it does:
//   1. Find outcome nodes created since --since (default: 24h ago)
//   2. Find patterns those outcomes connect to — cluster by shared pattern
//   3. If cluster >= 3 outcomes share a pattern AND avg confidence > 0.7
//      → distill a reasoning-bank entry for that pattern
//   4. Find edges with confidence < 0.1 AND trial_count > 5 → flag as anti-pattern
//   5. Find edges where decayed visit_count < 0.05 → mark orphaned candidate
//
// Runs safely in --dry-run mode (no writes). Idempotent.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

function expandTilde(p) {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}
import {
  readGraph,
  writeGraph,
  parseFrontmatter,
  serializeFrontmatter,
  decayedVisitScore,
  computeSalience,
  agentMemoryRoot,
} from './graph-lib.js';
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

const [slug] = positional;
if (!slug) {
  console.error('Usage: graph-consolidate.js <slug> [--brain-path=PATH] [--dry-run] [--since=ISO_DATE]');
  process.exit(1);
}

const dryRun = !!flags['dry-run'];
const sinceDate = flags.since
  ? new Date(flags.since)
  : new Date(Date.now() - 24 * 60 * 60 * 1000); // default: 24h

const nexusDir = flags['brain-path']
  ? resolve(expandTilde(flags['brain-path']))
  : join(process.cwd(), 'nexus', slug);

const agentBrainDir = flags['agent-brain-path']
  ? resolve(expandTilde(flags['agent-brain-path']))
  : join(agentMemoryRoot(), 'nexus', 'agent-brain');

const graphPath = join(nexusDir, 'graph.json');
const agentGraphPath = join(agentBrainDir, 'graph.json');
const reasoningBankPath = join(agentBrainDir, '..', 'reasoning-bank.md');
const agentNodesDir = join(agentBrainDir, 'nodes');

let stats = { outcomesFound: 0, patternsDistilled: 0, antiPatternsFlagged: 0, edgesPruned: 0 };

console.log(`Consolidating [${slug}]${dryRun ? ' (DRY RUN)' : ''} — outcomes since ${sinceDate.toISOString()}\n`);

// ── Step 1: Find recent outcome nodes ────────────────────────────────────────

function loadAgentNodes(nodeType) {
  if (!existsSync(agentNodesDir)) return [];
  return readdirSync(agentNodesDir)
    .filter(f => f.startsWith(`${nodeType}-`) && f.endsWith('.md'))
    .map(f => {
      const content = readFileSync(join(agentNodesDir, f), 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      return { file: f, id: f.replace('.md', ''), frontmatter, content };
    });
}

const outcomeNodes = loadAgentNodes('outcome').filter(n => {
  const created = new Date(n.frontmatter.created || 0);
  return created >= sinceDate;
});

stats.outcomesFound = outcomeNodes.length;
console.log(`Found ${outcomeNodes.length} outcome node(s) since ${sinceDate.toISOString().slice(0, 10)}`);

// ── Step 2: Cluster outcomes by shared pattern connections ───────────────────

const patternClusters = new Map(); // pattern-id → [outcome nodes]

for (const outcome of outcomeNodes) {
  const connections = outcome.frontmatter.connections || [];
  for (const conn of connections) {
    const patternId = conn.replace(/\[\[|\]\]/g, '').trim();
    if (!patternId.startsWith('pattern-')) continue;
    if (!patternClusters.has(patternId)) patternClusters.set(patternId, []);
    patternClusters.get(patternId).push(outcome);
  }
}

// ── Step 3: Distill high-confidence clusters into reasoning bank ─────────────

let agentGraph = null;
if (existsSync(agentGraphPath)) {
  agentGraph = readGraph(agentGraphPath);
}

const reasoningEntries = [];

for (const [patternId, outcomes] of patternClusters) {
  if (outcomes.length < 3) {
    console.log(`  skip: ${patternId} — only ${outcomes.length} outcome(s), need >= 3`);
    continue;
  }

  // Compute average confidence from agent graph edges connecting this pattern to outcomes
  let totalConfidence = 0;
  let edgeCount = 0;
  if (agentGraph) {
    for (const outcome of outcomes) {
      const edge = agentGraph.edges.find(
        e => (e.source === patternId && e.target === outcome.id) ||
             (e.source === outcome.id && e.target === patternId)
      );
      if (edge) {
        totalConfidence += edge.weights.confidence || 0;
        edgeCount++;
      }
    }
  }
  const avgConfidence = edgeCount > 0 ? totalConfidence / edgeCount : 0;

  if (avgConfidence < 0.7) {
    console.log(`  skip: ${patternId} — avg confidence ${avgConfidence.toFixed(2)} < 0.70`);
    continue;
  }

  // Read pattern node for its content
  const patternPath = join(agentNodesDir, `${patternId}.md`);
  const patternContent = existsSync(patternPath)
    ? readFileSync(patternPath, 'utf8')
    : null;

  console.log(`  distill: ${patternId} (${outcomes.length} outcomes, avg_confidence=${avgConfidence.toFixed(2)})`);
  stats.patternsDistilled++;

  reasoningEntries.push({
    patternId,
    outcomeCount: outcomes.length,
    avgConfidence,
    patternContent,
    distilledAt: new Date().toISOString().slice(0, 10),
  });
}

// Append to reasoning-bank.md
if (reasoningEntries.length > 0) {
  let bankContent = existsSync(reasoningBankPath)
    ? readFileSync(reasoningBankPath, 'utf8')
    : '# Reasoning Bank\n\nDistilled patterns from agent outcomes.\n\n';

  for (const entry of reasoningEntries) {
    const section = [
      `## ${entry.patternId} (consolidated ${entry.distilledAt})`,
      ``,
      `**Outcomes:** ${entry.outcomeCount} | **Avg Confidence:** ${entry.avgConfidence.toFixed(2)}`,
      ``,
      entry.patternContent
        ? `### Pattern Content\n\n${entry.patternContent.replace(/^---[\s\S]*?---\n\n?/, '')}`
        : `_(pattern node not found — consolidated from outcome connections only)_`,
      ``,
      `---`,
      ``,
    ].join('\n');
    bankContent += section;
  }

  if (dryRun) {
    console.log(`\n[DRY RUN] Would write ${reasoningEntries.length} pattern(s) to reasoning-bank.md`);
  } else {
    mkdirSync(resolve(reasoningBankPath, '..'), { recursive: true });
    writeFileSync(reasoningBankPath, bankContent, 'utf8');
    console.log(`\nWrote ${reasoningEntries.length} pattern(s) to reasoning-bank.md`);
  }
}

// ── Step 4: Flag anti-patterns (confidence < 0.1, trial_count > 5) ───────────

if (agentGraph) {
  const antiPatternEdges = agentGraph.edges.filter(
    e => (e.weights.confidence || 0) < 0.1 && (e.weights._confidence_trials || 0) > 5
  );

  if (antiPatternEdges.length > 0) {
    console.log(`\nAnti-pattern edges (confidence < 0.1, trials > 5):`);
    for (const edge of antiPatternEdges) {
      console.log(`  ${edge.source} → ${edge.target}  confidence=${edge.weights.confidence}  trials=${edge.weights._confidence_trials}`);
    }
    stats.antiPatternsFlagged = antiPatternEdges.length;

    if (!dryRun && agentGraph) {
      // Mark anti-pattern edges with a flag (don't delete — preserve history)
      const updatedEdges = agentGraph.edges.map(e => {
        const isAnti = (e.weights.confidence || 0) < 0.1 && (e.weights._confidence_trials || 0) > 5;
        return isAnti ? { ...e, anti_pattern: true } : e;
      });
      const updated = { ...agentGraph, edges: updatedEdges };
      writeGraph(agentGraphPath, updated);
      console.log(`Flagged ${antiPatternEdges.length} anti-pattern edge(s) in agent graph`);
    }
  }
}

// ── Step 5: Flag stale edges in repo graph ────────────────────────────────────

if (existsSync(graphPath)) {
  const repoGraph = readGraph(graphPath);
  const now = Date.now();
  const staleEdges = repoGraph.edges.filter(e => {
    const decayed = decayedVisitScore(
      e.weights.visit_count,
      e.weights.last_visited,
      now
    );
    return decayed < 0.05 && (e.weights._visit_raw || 0) > 0;
  });

  if (staleEdges.length > 0) {
    console.log(`\nStale repo edges (decayed visit_count < 0.05):`);
    for (const e of staleEdges.slice(0, 10)) {
      console.log(`  ${e.source} → ${e.target}  (last_visited: ${e.weights.last_visited || 'never'})`);
    }
    if (staleEdges.length > 10) console.log(`  ... and ${staleEdges.length - 10} more`);
    stats.edgesPruned = staleEdges.length;
    if (!dryRun) {
      console.log(`  (stale edges logged only — run graph-init to regenerate repo brain)`);
    }
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Consolidation ${dryRun ? '(dry run) ' : ''}complete:`);
console.log(`  Outcomes scanned:     ${stats.outcomesFound}`);
console.log(`  Patterns distilled:   ${stats.patternsDistilled}`);
console.log(`  Anti-patterns found:  ${stats.antiPatternsFlagged}`);
console.log(`  Stale edges logged:   ${stats.edgesPruned}`);
}

if (isMainModule(import.meta.url)) main();
