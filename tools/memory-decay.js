#!/usr/bin/env node
// memory-decay.js — decay pass over a brain's graph, archiving stale edges

import { join } from 'node:path';
import {
  agentMemoryRoot,
  readGraphIfExists,
  writeGraph,
  decayedVisitScore,
  recomputeComposite,
} from './graph/graph-lib.js';

function printHelp() {
  console.log(`
memory-decay — decay pass over a brain's graph, archiving stale edges

Usage:
  node tools/memory-decay.js --brain=<slug> [--dry-run] [--archive-threshold=0.05]

Options:
  --brain=<slug>               Brain slug (e.g. user-brain, friday, jarvis) [required]
  --dry-run                    Print what would be archived, don't write
  --archive-threshold=<value>  Composite threshold for archiving (default: 0.05)
  --help                       Print this help message

Behavior:
  1. Load graph from {agentMemoryRoot}/nexus/{brain}/graph.json
  2. For each edge, compute decayed composite using degree centrality-modulated half-life
  3. Archive edges where decayed composite < threshold AND valid_until is null
  4. Print summary and write graph back (unless --dry-run)
  `);
}

function parseArgs(argv) {
  const args = {};
  const flags = [];
  for (const arg of argv.slice(2)) {
    if (arg === '--help') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--dry-run') {
      flags.push('dry-run');
    } else if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      if (value === undefined) {
        flags.push(key);
      } else {
        args[key] = value;
      }
    }
  }
  return { args, flags };
}

function computeDegreeCentrality(graph, nodeId) {
  const edgeCount = graph.edges.filter(e => e.source === nodeId || e.target === nodeId).length;
  const totalNodes = graph.nodes.length;
  if (totalNodes <= 1) return 0;
  return Math.min(1, edgeCount / (totalNodes - 1));
}

function main() {
  const { args, flags } = parseArgs(process.argv);

  if (!args.brain) {
    console.error('Error: --brain is required.');
    printHelp();
    process.exit(1);
  }

  const brain = args.brain;
  const dryRun = flags.includes('dry-run');
  const archiveThreshold = parseFloat(args['archive-threshold'] || '0.05');

  const graphPath = join(agentMemoryRoot(), 'nexus', brain, 'graph.json');

  const graph = readGraphIfExists(graphPath);
  if (!graph) {
    // A brain that has never been initialized on this host has no graph.json yet --
    // that's a normal state (per-repo/agent brains are gitignored), not a failure.
    // Skip cleanly rather than hard-exiting, and don't write a placeholder graph.
    console.log(`decay pass [${brain}]: no graph.json at ${graphPath} -- brain not initialized on this host, skipping`);
    return;
  }

  const now = Date.now();
  const archivedIds = [];

  const centralityMap = new Map();
  for (const nodeId of graph.nodes) {
    const edgeCount = graph.edges.filter(e => e.source === nodeId || e.target === nodeId).length;
    const centrality = graph.nodes.length <= 1 ? 0 : Math.min(1, edgeCount / (graph.nodes.length - 1));
    centralityMap.set(nodeId, centrality);
  }

  // Process each edge
  const updatedEdges = graph.edges.map(edge => {
    // Only consider active edges (valid_until is null)
    if (edge.weights.valid_until !== null) {
      return edge;
    }

    // Use cached degree centrality for source node
    const degreeCentrality = centralityMap.get(edge.source) ?? 0;

    // Compute decayed visit score
    const decayedVisit = decayedVisitScore(
      edge.weights.visit_count,
      edge.weights.last_visited,
      now,
      30,
      degreeCentrality
    );

    // Recompute composite with decayed visit score
    const decayedWeights = {
      ...edge.weights,
      visit_count: decayedVisit,
    };
    const decayedComposite = recomputeComposite(decayedWeights);

    // Archive if below threshold
    if (decayedComposite < archiveThreshold) {
      archivedIds.push(`${edge.source} → ${edge.target}`);
      return {
        ...edge,
        weights: {
          ...edge.weights,
          visit_count: decayedVisit,
        },
        composite: decayedComposite,
        valid_until: new Date().toISOString(),
      };
    }

    // Otherwise, update stored visit_count with decayed value (for identification)
    return {
      ...edge,
      weights: {
        ...edge.weights,
        visit_count: decayedVisit,
      },
      composite: decayedComposite,
    };
  });

  const activeCount = updatedEdges.filter(e => e.weights.valid_until === null).length;

  if (dryRun) {
    console.log(`decay pass [${brain}] (dry-run): ${archivedIds.length} edges would be archived, ${activeCount} edges active`);
    if (archivedIds.length > 0) {
      archivedIds.forEach(id => console.log(`  → ${id}`));
    }
  } else {
    const updated = { ...graph, edges: updatedEdges };
    writeGraph(graphPath, updated);
    console.log(`decay pass [${brain}]: ${archivedIds.length} edges archived, ${activeCount} edges active`);
  }
}

main();
