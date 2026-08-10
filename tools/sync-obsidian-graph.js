#!/usr/bin/env node

/**
 * sync-obsidian-graph.js
 *
 * Syncs graph.json edges to markdown wikilinks for Obsidian visualization.
 * Reads each brain's graph.json and appends "## Connections" section to nodes.
 *
 * Usage:
 *   node sync-obsidian-graph.js                    # sync all brains
 *   node sync-obsidian-graph.js personal-brain     # sync one brain
 */

import fs from 'fs';
import path from 'path';
import { isMainModule } from './is-main.js';

const NEXUS_DIR = path.join(process.env.HOME || process.env.USERPROFILE, 'agent-memory', 'nexus');

function findGraphJsonFiles() {
  const graphs = [];

  // Personal brain
  if (fs.existsSync(path.join(NEXUS_DIR, 'personal-brain', 'graph.json'))) {
    graphs.push({
      brain: 'personal-brain',
      graphPath: path.join(NEXUS_DIR, 'personal-brain', 'graph.json'),
      nodesDir: path.join(NEXUS_DIR, 'personal-brain', 'nodes')
    });
  }

  // Agent-brain (global + per-agent)
  const agentBrainDir = path.join(NEXUS_DIR, 'agent-brain');
  if (fs.existsSync(path.join(agentBrainDir, 'graph.json'))) {
    graphs.push({
      brain: 'agent-brain',
      graphPath: path.join(agentBrainDir, 'graph.json'),
      nodesDir: path.join(agentBrainDir, 'nodes')
    });
  }

  // Per-agent brains (jarvis, friday, sam, etc.)
  const agentDirs = fs.readdirSync(agentBrainDir).filter(f =>
    fs.statSync(path.join(agentBrainDir, f)).isDirectory() &&
    fs.existsSync(path.join(agentBrainDir, f, 'graph.json'))
  );

  agentDirs.forEach(agent => {
    graphs.push({
      brain: `agent-brain/${agent}`,
      graphPath: path.join(agentBrainDir, agent, 'graph.json'),
      nodesDir: path.join(agentBrainDir, agent, 'nodes')
    });
  });

  // Repo brains (agentsystem, genie, basely, etc.)
  const repoBrainDir = path.join(NEXUS_DIR);
  const repoDirs = fs.readdirSync(repoBrainDir)
    .filter(f => f.startsWith('agentsystem') || f.startsWith('genie') || f.startsWith('basely'))
    .filter(f => fs.statSync(path.join(repoBrainDir, f)).isDirectory() &&
                  fs.existsSync(path.join(repoBrainDir, f, 'graph.json')));

  repoDirs.forEach(repo => {
    graphs.push({
      brain: repo,
      graphPath: path.join(repoBrainDir, repo, 'graph.json'),
      nodesDir: path.join(repoBrainDir, repo, 'nodes')
    });
  });

  return graphs;
}

function readGraph(graphPath) {
  try {
    const raw = fs.readFileSync(graphPath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Error reading ${graphPath}: ${e.message}`);
    return null;
  }
}

function buildConnectionMap(graph) {
  const map = new Map(); // node -> [targets]

  if (!graph.edges) return map;

  graph.edges.forEach(edge => {
    if (!map.has(edge.source)) map.set(edge.source, []);
    if (!map.has(edge.target)) map.set(edge.target, []);

    map.get(edge.source).push(edge.target);
  });

  return map;
}

function updateNodeFile(nodePath, connections) {
  if (!fs.existsSync(nodePath)) return false;

  let content = fs.readFileSync(nodePath, 'utf8');

  // Remove existing ## Connections section
  content = content.replace(/\n## Connections\n\n[\s\S]*?(?=\n##|$)/m, '');

  // Remove frontmatter connections field (not parsed by Obsidian)
  content = content.replace(/connections: \[\[.*?\]\](,\n)?/s, '');

  if (connections.length === 0) {
    fs.writeFileSync(nodePath, content, 'utf8');
    return true;
  }

  // Append new connections section — ONE link per line
  const connSection = `\n## Connections\n\n${connections.map(c => `- [[${c}]]`).join('\n')}\n`;
  content = content.replace(/\n$/, '') + connSection;

  fs.writeFileSync(nodePath, content, 'utf8');
  return true;
}

function syncBrain(graphInfo) {
  console.log(`\n📊 Syncing ${graphInfo.brain}...`);

  const graph = readGraph(graphInfo.graphPath);
  if (!graph) return 0;

  const connectionMap = buildConnectionMap(graph);
  let updated = 0;

  // Get all node files
  if (!fs.existsSync(graphInfo.nodesDir)) {
    console.log(`  ⚠️  No nodes directory: ${graphInfo.nodesDir}`);
    return 0;
  }

  const nodeFiles = fs.readdirSync(graphInfo.nodesDir)
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace('.md', ''));

  nodeFiles.forEach(nodeId => {
    const nodePath = path.join(graphInfo.nodesDir, `${nodeId}.md`);
    const connections = connectionMap.get(nodeId) || [];

    if (updateNodeFile(nodePath, connections)) {
      updated++;
    }
  });

  console.log(`  ✓ Updated ${updated}/${nodeFiles.length} nodes`);
  return updated;
}

async function main() {
  const filter = process.argv[2];
  const graphs = findGraphJsonFiles()
    .filter(g => !filter || g.brain === filter || g.brain.includes(filter));

  if (graphs.length === 0) {
    console.log(`No brains found matching "${filter || 'any'}"`);
    console.log(`\nAvailable brains:`);
    findGraphJsonFiles().forEach(g => console.log(`  - ${g.brain}`));
    process.exit(1);
  }

  console.log(`Found ${graphs.length} brain(s) to sync`);

  let totalUpdated = 0;
  graphs.forEach(g => {
    totalUpdated += syncBrain(g);
  });

  console.log(`\n✅ Done. Updated ${totalUpdated} node files.`);
  console.log(`\nNext: Open your Obsidian vault and refresh the graph view.`);
  console.log(`Settings > Graph view > Filter by "Connections" to see edges.`);
}

if (isMainModule(import.meta.url)) await main();
