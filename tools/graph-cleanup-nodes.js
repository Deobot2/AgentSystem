#!/usr/bin/env node

/**
 * graph-cleanup-nodes.js
 *
 * Removes specified nodes from graph.json files (both node entries and edges).
 *
 * Usage:
 *   node graph-cleanup-nodes.js
 */

import fs from 'fs';
import path from 'path';
import { isMainModule } from './is-main.js';

const NEXUS_DIR = path.join(process.env.USERPROFILE || process.env.HOME, 'agent-memory', 'nexus');

const nodesToDelete = [
  { brain: 'personal-brain', nodes: ['basely-is-currently-trying-to-launch-to-customers', '2026-06-21-personal-brain-initialized'] },
  { brain: 'agent-brain', nodes: ['agent-pym', 'agent-nat', 'agent-wanda', 'agent-astra', 'agent-threepio', 'agent-r2d2'] },
  { brain: 'agent-brain/friday', nodes: ['friday-hierarchical-swarm-authority'] }
];

function cleanGraph(graphPath, nodesToRemove) {
  try {
    const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
    const before = graph.nodes.length;

    // Remove nodes
    graph.nodes = graph.nodes.filter(n => !nodesToRemove.includes(n));

    // Remove edges referencing deleted nodes
    graph.edges = (graph.edges || []).filter(e =>
      !nodesToRemove.includes(e.source) && !nodesToRemove.includes(e.target)
    );

    const after = graph.nodes.length;
    if (before !== after) {
      fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2), 'utf8');
      console.log(`✓ ${graphPath}: removed ${before - after} nodes`);
    }
  } catch (e) {
    console.error(`✗ Error: ${graphPath}: ${e.message}`);
  }
}

function main() {
  console.log('🧹 Cleaning graph.json files...\n');

  nodesToDelete.forEach(({ brain, nodes }) => {
    let graphPath;
    if (brain === 'personal-brain') {
      graphPath = path.join(NEXUS_DIR, 'personal-brain', 'graph.json');
    } else if (brain === 'agent-brain') {
      graphPath = path.join(NEXUS_DIR, 'agent-brain', 'graph.json');
    } else {
      const [base, agent] = brain.split('/');
      graphPath = path.join(NEXUS_DIR, base, agent, 'graph.json');
    }

    if (fs.existsSync(graphPath)) {
      cleanGraph(graphPath, nodes);
    }
  });

  console.log('\n✅ Done!');
}

if (isMainModule(import.meta.url)) main();
