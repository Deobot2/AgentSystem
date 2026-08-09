#!/usr/bin/env node
// memory-decay.js — decay pass over a brain's graph, archiving stale edges

import { readdirSync, existsSync } from 'node:fs';
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
  node tools/memory-decay.js --all         [--dry-run] [--archive-threshold=0.05]

Options:
  --brain=<slug>               Brain slug (e.g. personal-brain, agent-brain/jarvis)
  --all                        Decay every brain found under {agentMemoryRoot}/nexus/
  --require-graph              With --brain, treat a missing graph.json as an error
  --dry-run                    Print what would be archived, don't write
  --archive-threshold=<value>  Composite threshold for archiving (default: 0.05)
  --help                       Print this help message

Exactly one of --brain or --all is required.

Behavior:
  1. Load graph from {agentMemoryRoot}/nexus/{brain}/graph.json
  2. For each edge, compute decayed composite using degree centrality-modulated half-life
  3. Archive edges where decayed composite < threshold AND valid_until is null
  4. Print summary and write graph back (unless --dry-run)

Note on brain slugs: only brains that live UNDER ~/agent-memory/nexus/ are valid here —
\`personal-brain\` and \`agent-brain/<agent>\`. Repo brains live at <repo>/nexus/<slug>/
(graph-init.js's default) and are gitignored, so a repo slug like \`agentsystem\` names a
path that never exists on any host. --all exists so callers stop guessing.
  `);
}

// A brain is any directory under nexus/ holding a graph.json, plus the same one level down
// inside agent-brain/ (which is a container of per-agent brains, not a brain itself).
// Discovery rather than a hardcoded list because the hardcoded list is what was wrong: the CI job
// named `agentsystem`, a slug that cannot exist here, and silently decayed nothing for months.
function discoverBrains(nexusDir) {
  if (!existsSync(nexusDir)) return [];
  const found = [];
  const entries = readdirSync(nexusDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  for (const name of entries) {
    if (existsSync(join(nexusDir, name, 'graph.json'))) found.push(name);
    if (name !== 'agent-brain') continue;
    const agents = readdirSync(join(nexusDir, name), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const agent of agents) {
      if (existsSync(join(nexusDir, name, agent, 'graph.json'))) found.push(`${name}/${agent}`);
    }
  }
  return found;
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

// Returns { brain, skipped, archived, active } so the caller can decide what a skip means.
// --all needs to distinguish "decayed 0 edges" from "did not run", which the old
// print-and-return-undefined shape could not express -- and that gap is exactly how this job
// reported success while pruning nothing.
function decayBrain(brain, { dryRun, archiveThreshold, requireGraph }) {
  const graphPath = join(agentMemoryRoot(), 'nexus', brain, 'graph.json');

  const graph = readGraphIfExists(graphPath);
  if (!graph) {
    // A brain that has never been initialized on this host has no graph.json yet --
    // that's a normal state (per-repo/agent brains are gitignored), not a failure.
    // Skip cleanly rather than hard-exiting, and don't write a placeholder graph.
    // --require-graph is for callers that named a specific brain and mean it: a scheduled job
    // asking for `personal-brain` and silently getting nothing is a false green.
    if (requireGraph) {
      console.error(`decay pass [${brain}]: no graph.json at ${graphPath} -- refusing to report success for a brain that was explicitly requested. Initialize it (tools/bootstrap-repo.js) or drop --require-graph.`);
      process.exit(1);
    }
    console.log(`decay pass [${brain}]: no graph.json at ${graphPath} -- brain not initialized on this host, skipping`);
    return { brain, skipped: true, archived: 0, active: 0 };
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
      // valid_until lives inside weights (graph-lib.js addEdge), and that is where the
      // "is this edge active" test above reads it. Stamping only a top-level valid_until left the
      // edge active forever, so every pass re-archived the same edges and archived nothing for
      // real. Write both: weights is the one that counts, the top-level copy stays for readers
      // that already look there.
      const archivedAt = new Date().toISOString();
      return {
        ...edge,
        weights: {
          ...edge.weights,
          visit_count: decayedVisit,
          valid_until: archivedAt,
        },
        composite: decayedComposite,
        valid_until: archivedAt,
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

  return { brain, skipped: false, archived: archivedIds.length, active: activeCount };
}

function main() {
  const { args, flags } = parseArgs(process.argv);

  const all = flags.includes('all');
  if (!args.brain && !all) {
    console.error('Error: one of --brain=<slug> or --all is required.');
    printHelp();
    process.exit(1);
  }
  if (args.brain && all) {
    console.error('Error: --brain and --all are mutually exclusive.');
    process.exit(1);
  }

  const opts = {
    dryRun: flags.includes('dry-run'),
    archiveThreshold: parseFloat(args['archive-threshold'] || '0.05'),
    requireGraph: flags.includes('require-graph'),
  };

  if (!all) {
    decayBrain(args.brain, opts);
    return;
  }

  const nexusDir = join(agentMemoryRoot(), 'nexus');
  const brains = discoverBrains(nexusDir);

  // Loud, not silent. "Nothing to do" and "I could not find anything to do" look identical from
  // the outside, and for this job the second one was true every week for months while the run
  // stayed green. A brain-less host is a broken host, so say so and exit nonzero.
  if (brains.length === 0) {
    console.error(`decay pass: no brains found under ${nexusDir} -- nothing was decayed. Initialize the brains on this host with \`node tools/bootstrap-repo.js --all ~/dev\`.`);
    process.exit(1);
  }

  console.log(`decay pass: ${brains.length} brain(s) found under ${nexusDir}: ${brains.join(', ')}`);
  const results = brains.map((brain) => decayBrain(brain, { ...opts, requireGraph: false }));

  const archived = results.reduce((n, r) => n + r.archived, 0);
  const active = results.reduce((n, r) => n + r.active, 0);
  console.log(`decay pass: ${results.length} brain(s) processed, ${archived} edge(s) archived, ${active} edge(s) active`);
}

main();
