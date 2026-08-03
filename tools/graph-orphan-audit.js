#!/usr/bin/env node

/**
 * graph-orphan-audit.js
 *
 * Finds orphan nodes (no incoming or outgoing edges) in brains.
 * Groups nodes by category for subgraph organization.
 * Reports what needs fixing.
 *
 * Usage:
 *   node graph-orphan-audit.js                  # audit all brains
 *   node graph-orphan-audit.js personal-brain   # audit one brain
 *   node graph-orphan-audit.js --fix            # auto-connect orphans to category hubs
 */

import fs from 'fs';
import path from 'path';

const NEXUS_DIR = path.join(process.env.USERPROFILE || process.env.HOME, 'agent-memory', 'nexus');

function findGraphJsonFiles() {
  const graphs = [];

  // Personal brain
  const personalGraph = path.join(NEXUS_DIR, 'personal-brain', 'graph.json');
  if (fs.existsSync(personalGraph)) {
    graphs.push({
      brain: 'personal-brain',
      graphPath: personalGraph,
    });
  }

  // Agent brain (global + per-agent)
  const agentBrainDir = path.join(NEXUS_DIR, 'agent-brain');
  if (fs.existsSync(agentBrainDir)) {
    const globalGraph = path.join(agentBrainDir, 'graph.json');
    if (fs.existsSync(globalGraph)) {
      graphs.push({
        brain: 'agent-brain',
        graphPath: globalGraph,
      });
    }

    // Per-agent brains
    try {
      const agentDirs = fs.readdirSync(agentBrainDir).filter(f => {
        const fullPath = path.join(agentBrainDir, f);
        return fs.statSync(fullPath).isDirectory() &&
               fs.existsSync(path.join(fullPath, 'graph.json'));
      });

      agentDirs.forEach(agent => {
        graphs.push({
          brain: `agent-brain/${agent}`,
          graphPath: path.join(agentBrainDir, agent, 'graph.json'),
        });
      });
    } catch (e) {
      // Skip if can't read agent dirs
    }
  }

  return graphs;
}

function readGraph(graphPath) {
  try {
    return JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  } catch (e) {
    console.error(`Error reading ${graphPath}: ${e.message}`);
    return null;
  }
}

function categorizeNode(nodeId) {
  // Infer category from node ID
  if (nodeId.startsWith('nathan-') || nodeId.startsWith('nathans-')) return 'personal';
  if (nodeId.startsWith('arbor-genie-')) return 'arbor-genie';
  if (nodeId.startsWith('basely-')) return 'basely';
  if (nodeId.startsWith('agent-')) return 'agent';
  if (nodeId.startsWith('manual-')) return 'patterns';
  if (nodeId.match(/^(all-repos|prs-|branch-|commit-)/)) return 'workflow';
  if (nodeId.match(/^(asking-for|long-summaries|rebuilding-)/)) return 'preferences';
  return 'uncategorized';
}

function auditBrain(graphInfo) {
  console.log(`\n📊 Auditing ${graphInfo.brain}...`);

  const graph = readGraph(graphInfo.graphPath);
  if (!graph) return { orphans: [], categorized: {} };

  // Build edge map
  const edges = new Map();
  const inbound = new Map();
  const outbound = new Map();

  graph.nodes?.forEach(n => {
    edges.set(n, { in: [], out: [] });
    inbound.set(n, []);
    outbound.set(n, []);
  });

  graph.edges?.forEach(e => {
    if (outbound.has(e.source)) outbound.get(e.source).push(e.target);
    if (inbound.has(e.target)) inbound.get(e.target).push(e.source);
  });

  // Find orphans (0 edges in + out)
  const orphans = graph.nodes?.filter(n =>
    (!outbound.get(n) || outbound.get(n).length === 0) &&
    (!inbound.get(n) || inbound.get(n).length === 0)
  ) || [];

  // Categorize all nodes
  const categorized = {};
  graph.nodes?.forEach(n => {
    const cat = categorizeNode(n);
    if (!categorized[cat]) categorized[cat] = [];
    categorized[cat].push(n);
  });

  console.log(`  Total nodes: ${graph.nodes?.length || 0}`);
  console.log(`  Total edges: ${graph.edges?.length || 0}`);
  console.log(`  Orphans: ${orphans.length}`);

  if (orphans.length > 0) {
    console.log(`  \n  Orphan nodes:`);
    orphans.slice(0, 10).forEach(o => console.log(`    - ${o}`));
    if (orphans.length > 10) console.log(`    ... and ${orphans.length - 10} more`);
  }

  console.log(`\n  Categories:`);
  Object.entries(categorized).sort((a, b) => b[1].length - a[1].length).forEach(([cat, nodes]) => {
    console.log(`    ${cat}: ${nodes.length} nodes`);
  });

  return { orphans, categorized };
}

async function main() {
  const fix = process.argv.includes('--fix');
  const filter = process.argv.slice(2).find(a => !a.startsWith('-'));

  const allGraphs = findGraphJsonFiles();
  const graphs = allGraphs
    .filter(g => !filter || g.brain === filter || g.brain.includes(filter));

  if (graphs.length === 0) {
    console.log('No brains found');
    process.exit(1);
  }

  console.log(`🔍 Scanning ${graphs.length} brain(s) for orphans...`);

  const allOrphans = [];
  graphs.forEach(g => {
    const { orphans } = auditBrain(g);
    allOrphans.push(...orphans.map(o => ({ brain: g.brain, node: o })));
  });

  console.log(`\n\n📈 SUMMARY`);
  console.log(`Total orphan nodes: ${allOrphans.length}`);

  if (allOrphans.length > 0) {
    console.log(`\nOrphan nodes by brain:`);
    const byBrain = {};
    allOrphans.forEach(({ brain, node }) => {
      if (!byBrain[brain]) byBrain[brain] = [];
      byBrain[brain].push(node);
    });
    Object.entries(byBrain).forEach(([brain, nodes]) => {
      console.log(`  ${brain}: ${nodes.length}`);
    });
  }

  console.log(`\n💡 To fix:`);
  console.log(`  1. Delete genuinely orphan/duplicate nodes`);
  console.log(`  2. Connect remaining orphans to category hub nodes`);
  console.log(`  3. Rerun: node graph-orphan-audit.js --fix`);
}

await main();
