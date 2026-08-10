#!/usr/bin/env node

/**
 * graph-auto-connect.js
 *
 * Auto-connects orphan nodes to appropriate category hubs.
 *
 * Strategy:
 * - Delete personal-brain duplicates
 * - Delete global agent-brain stubs
 * - Create category hubs if missing
 * - Connect orphans to hubs
 * - Connect category hubs to root nodes
 *
 * Usage:
 *   node graph-auto-connect.js                # dry-run (show what would happen)
 *   node graph-auto-connect.js --apply        # apply fixes
 */

import fs from 'fs';
import path from 'path';
import { isMainModule } from './is-main.js';

const NEXUS_DIR = path.join(process.env.USERPROFILE || process.env.HOME, 'agent-memory', 'nexus');

function deleteNode(brain, nodeId) {
  const nodePath = path.join(NEXUS_DIR, brain.startsWith('agent-brain/') ? 'agent-brain' : brain,
    brain.startsWith('agent-brain/') ? brain.split('/')[1] : '',
    'nodes', `${nodeId}.md`);
  const actualPath = path.join(NEXUS_DIR, brain.includes('/') ? brain.split('/').slice(0, -1).join(path.sep) : brain,
    brain.includes('/') ? brain.split('/').pop() : '',
    'nodes', `${nodeId}.md`);

  // Proper path resolution
  let basePath, subPath;
  if (brain === 'personal-brain') {
    basePath = path.join(NEXUS_DIR, 'personal-brain');
  } else if (brain === 'agent-brain') {
    basePath = path.join(NEXUS_DIR, 'agent-brain');
  } else if (brain.startsWith('agent-brain/')) {
    const agentName = brain.split('/')[1];
    basePath = path.join(NEXUS_DIR, 'agent-brain', agentName);
  }

  const fullPath = path.join(basePath, 'nodes', `${nodeId}.md`);
  if (fs.existsSync(fullPath)) {
    console.log(`  Delete: ${brain}/${nodeId}`);
    return { action: 'delete', path: fullPath };
  }
  return null;
}

function connectOrphanToHub(brain, orphanId, hubId, graphPath) {
  try {
    let graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));

    // Check if edge already exists
    const edgeExists = graph.edges?.some(e => e.source === orphanId && e.target === hubId);
    if (edgeExists) return null;

    // Add edge from orphan to hub
    if (!graph.edges) graph.edges = [];
    graph.edges.push({ source: orphanId, target: hubId });

    console.log(`  Connect: ${orphanId} -> ${hubId}`);
    return { action: 'connect', graphPath, graph };
  } catch (e) {
    console.error(`  Error: ${e.message}`);
    return null;
  }
}

function createHubNodeIfMissing(brain, hubId, title, description) {
  const basePath = brain === 'personal-brain' ?
    path.join(NEXUS_DIR, 'personal-brain') :
    path.join(NEXUS_DIR, brain.split('/').slice(0, -1).join(path.sep), brain.split('/').pop());

  const nodePath = path.join(basePath, 'nodes', `${hubId}.md`);
  if (fs.existsSync(nodePath)) {
    return null; // Already exists
  }

  const content = `---
id: ${hubId}
type: hub
brain: ${brain}
created: ${new Date().toISOString().split('T')[0]}
relevance_keywords: [${hubId.split('-').slice(0, 2).join(', ')}]
importance: 0.7
hot: true
---

${title}

${description}
`;

  console.log(`  Create hub: ${brain}/${hubId}`);
  return { action: 'create', path: nodePath, content };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const mode = apply ? 'APPLY' : 'DRY-RUN';
  console.log(`\n🔧 Graph auto-connect (${mode})\n`);

  const fixes = [];
  const nodeDeletes = []; // Track which nodes to remove from graph.json

  // 1. Personal brain: delete duplicates
  console.log('📋 Personal brain:');
  const pbn1 = deleteNode('personal-brain', 'basely-is-currently-trying-to-launch-to-customers');
  if (pbn1) { fixes.push(pbn1); nodeDeletes.push({ brain: 'personal-brain', nodeId: 'basely-is-currently-trying-to-launch-to-customers' }); }
  const pbn2 = deleteNode('personal-brain', '2026-06-21-personal-brain-initialized');
  if (pbn2) { fixes.push(pbn2); nodeDeletes.push({ brain: 'personal-brain', nodeId: '2026-06-21-personal-brain-initialized' }); }

  // 2. Agent brain: delete incomplete stubs, replace with hub
  console.log('\n📋 Agent brain (global):');
  const agentStubs = ['agent-pym', 'agent-nat', 'agent-wanda', 'agent-astra', 'agent-threepio', 'agent-r2d2'];
  agentStubs.forEach(stub => {
    const del = deleteNode('agent-brain', stub);
    if (del) { fixes.push(del); nodeDeletes.push({ brain: 'agent-brain', nodeId: stub }); }
  });

  // Create agent-brain hub if missing
  const agentHub = createHubNodeIfMissing('agent-brain', 'agent-definitions-index',
    '# Agent Definitions Index',
    'Hub connecting to per-agent brains (jarvis, friday, sam, leo, nat, pym, astra, wanda, r2d2, threepio, ultron)');
  if (agentHub) fixes.push(agentHub);

  // 3. Friday brain: connect orphans to friday-core
  console.log('\n📋 Agent brain/friday:');
  const fridayOrphans = [
    'friday-startup-lean-4-steps',
    'friday-mcp-lazy-loading',
    'friday-mandatory-delegation-friday-never-does-primary-execution',
    'friday-audit-cycle-fridays-execution-loop',
    'friday-hierarchical-swarm-authority'
  ];

  // Create friday-core hub
  const fridayHub = createHubNodeIfMissing('agent-brain/friday', 'friday-core',
    '# Friday Core Knowledge',
    'Central hub for Friday (CTO) agent definition, capabilities, and domain knowledge.');
  if (fridayHub) fixes.push(fridayHub);

  // Connect friday orphans to hub
  const fridayGraphPath = path.join(NEXUS_DIR, 'agent-brain', 'friday', 'graph.json');
  fridayOrphans.forEach(orphan => {
    const conn = connectOrphanToHub('agent-brain/friday', orphan, 'friday-core', fridayGraphPath);
    if (conn) fixes.push(conn);
  });

  // Apply fixes if requested
  if (apply) {
    console.log(`\n✅ Applying ${fixes.length} fixes...\n`);

    const graphUpdates = new Map();

    // Process deletions
    nodeDeletes.forEach(({ brain, nodeId }) => {
      const graphPath = brain === 'personal-brain' ?
        path.join(NEXUS_DIR, 'personal-brain', 'graph.json') :
        path.join(NEXUS_DIR, brain.split('/').slice(0, -1).join(path.sep), brain.split('/').pop(), 'graph.json');

      console.log(`Deleting ${brain}/${nodeId}`);

      // Remove from graph.json nodes array
      if (!graphUpdates.has(graphPath)) {
        const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
        graphUpdates.set(graphPath, graph);
      }

      const graph = graphUpdates.get(graphPath);
      graph.nodes = graph.nodes.filter(n => n !== nodeId);
      graph.edges = (graph.edges || []).filter(e => e.source !== nodeId && e.target !== nodeId);

      // Delete node file
      const nodePath = path.join(NEXUS_DIR, brain.split('/').slice(0).join(path.sep), 'nodes', `${nodeId}.md`);
      if (fs.existsSync(nodePath)) {
        fs.unlinkSync(nodePath);
      }
    });

    // Process other fixes
    fixes.forEach(fix => {
      if (fix.action === 'create') {
        console.log(`Creating ${fix.path}`);
        fs.writeFileSync(fix.path, fix.content, 'utf8');

        // Add new node to graph if it's a hub
        const pathParts = fix.path.split(path.sep);
        const nodeId = pathParts[pathParts.length - 1].replace('.md', '');
        const brainPath = pathParts.slice(0, -2).join(path.sep);
        const graphPath = path.join(brainPath, 'graph.json');

        if (fs.existsSync(graphPath)) {
          if (!graphUpdates.has(graphPath)) {
            graphUpdates.set(graphPath, JSON.parse(fs.readFileSync(graphPath, 'utf8')));
          }
          const graph = graphUpdates.get(graphPath);
          if (!graph.nodes.includes(nodeId)) {
            graph.nodes.push(nodeId);
          }
        }
      } else if (fix.action === 'connect') {
        graphUpdates.set(fix.graphPath, fix.graph);
      }
    });

    // Write all graph updates
    graphUpdates.forEach((graph, graphPath) => {
      console.log(`Updating ${graphPath}`);
      fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2), 'utf8');
    });

    console.log(`\n✅ Done! Rerun audit to verify:\n  node graph-orphan-audit.js\n`);
  } else {
    console.log(`\n💡 Dry-run: ${fixes.filter(Boolean).length} fixes identified. Run with --apply to execute.\n`);
  }
}

if (isMainModule(import.meta.url)) await main();
