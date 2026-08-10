#!/usr/bin/env node
// agent-brain-init.js — one-time setup of the global agent brain scaffold
// Idempotent — safe to re-run. Creates ~/agent-memory/nexus/agent-brain/ (cross-CLI neutral path)
// Usage: node tools/graph/agent-brain-init.js
// Override path: AGENT_MEMORY_ROOT env var

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { emptyGraph, readGraph, writeGraph, addNode, serializeFrontmatter, agentMemoryRoot } from './graph-lib.js';
import { isMainModule } from '../is-main.js';

function main() {
const brainDir = join(agentMemoryRoot(), 'nexus', 'agent-brain');
const nodesDir = join(brainDir, 'nodes');
const graphPath = join(brainDir, 'graph.json');

mkdirSync(nodesDir, { recursive: true });

const today = new Date().toISOString().slice(0, 10);

let graph = existsSync(graphPath) ? readGraph(graphPath) : emptyGraph('agent', 'global');
graph = { ...graph, brain: 'agent', project_slug: 'global' };

const AGENTS = [
  'jarvis', 'friday', 'sam', 'ultron', 'pym',
  'leo', 'nat', 'wanda', 'astra', 'threepio', 'r2d2',
];

for (const agent of AGENTS) {
  const nodeId = `agent-${agent}`;
  const nodePath = join(nodesDir, `${nodeId}.md`);
  if (!existsSync(nodePath)) {
    const fm = {
      id: nodeId,
      type: 'agent',
      brain: 'agent',
      created: today,
      relevance_keywords: [agent],
      connections: [],
    };
    const name = agent[0].toUpperCase() + agent.slice(1);
    const body = `# Agent: ${name}\n\nDomain: TBD\nAuthority: TBD\nBias notes: TBD\n`;
    writeFileSync(nodePath, serializeFrontmatter(fm, body), 'utf8');
  }
  graph = addNode(graph, nodeId);
}

writeGraph(graphPath, graph);

const nodeCount = graph.nodes.length;
const indexContent = `# Agent Brain Index — Global\n\nInitialized: ${today}\nNodes: ${nodeCount} | Edges: ${graph.edges.length}\n\n## Purpose\n\nLong-term agent memory. Compounds across all projects.\nShared across ALL CLIs (Claude, Gemini, Copilot) via neutral path ~/agent-memory/nexus/.\nRepo brains decay; agent brain persists forever.\n\n## Node Types\n- Agent identity: ${graph.nodes.filter(n => n.startsWith('agent-')).length}\n- Decision patterns: ${graph.nodes.filter(n => n.startsWith('pattern-')).length}\n- Task outcomes: ${graph.nodes.filter(n => n.startsWith('outcome-')).length}\n- Cross-domain: ${graph.nodes.filter(n => n.startsWith('xdomain-')).length}\n\n## Usage\n\n\`\`\`\nnode tools/graph/graph-query.js global <keywords> --brain-path="$HOME/agent-memory/nexus/agent-brain"\nnode tools/graph/graph-weight.js confidence global <source> <target> <+0.1|-0.15>\n\`\`\`\n`;

writeFileSync(join(brainDir, 'INDEX.md'), indexContent, 'utf8');
console.log(`agent-brain-init: ${nodeCount} nodes → ${brainDir}`);
}

if (isMainModule(import.meta.url)) main();
