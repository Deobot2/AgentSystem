#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentMemoryRoot, readGraph, writeGraph, addNode, addEdge, emptyGraph, parseFrontmatter } from './graph/graph-lib.js';
import { isMainModule } from './is-main.js';

const AGENTS = ['jarvis', 'friday', 'sam', 'nat', 'ultron', 'pym', 'leo', 'astra', 'wanda', 'threepio', 'r2d2'];

function parseArgs(argv) {
  const args = { all: false, agent: null, dryRun: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--all') args.all = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg.startsWith('--agent=')) args.agent = arg.split('=')[1];
  }
  return args;
}

function slugify(text) {
  return text.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
}

function extractKeywords(header) {
  const words = header.toLowerCase().split(/\s+/).slice(0, 2);
  return words.filter(w => w.length > 0);
}

function readAgentDefinition(name) {
  const path = join(process.cwd(), '.agents', 'agents', `${name}.md`);
  const content = readFileSync(path, 'utf8');
  // Normalize line endings to \n for consistent parsing
  return content.replace(/\r\n/g, '\n');
}

function extractSections(body) {
  const lines = body.split('\n');
  const sections = [];
  let currentHeader = null;
  let currentContent = [];

  for (const line of lines) {
    // Match both unindented (## Header) and indented (  ## Header) headers
    const match = line.match(/^\s*##\s+(.+)$/);
    if (match) {
      if (currentHeader) {
        sections.push({
          header: currentHeader,
          content: currentContent.join('\n').trim(),
        });
      }
      currentHeader = match[1];
      currentContent = [];
    } else if (currentHeader) {
      currentContent.push(line);
    }
  }

  if (currentHeader) {
    sections.push({
      header: currentHeader,
      content: currentContent.join('\n').trim(),
    });
  }

  return sections;
}

function getFirstNonEmptyLine(body) {
  const lines = body.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) return trimmed;
  }
  return '';
}

function createSectionNode(agentName, section, createdDate) {
  const nodeId = `${agentName}-${slugify(section.header)}`;
  const frontmatter = {
    id: nodeId,
    type: 'agent-definition',
    brain: `agent-brain/${agentName}`,
    created: createdDate,
    agent: agentName,
    section: section.header,
    relevance_keywords: [agentName, ...extractKeywords(section.header)],
    hot: false,
  };

  const body = section.content;
  return { nodeId, frontmatter, body };
}

function createIdentityNode(agentName, body, frontmatterData, createdDate) {
  const nodeId = `${agentName}-identity`;
  const firstLine = getFirstNonEmptyLine(body);

  const roleKeywords = frontmatterData.mcps || [];
  const keywords = [agentName, ...roleKeywords.slice(0, 2)];

  const frontmatter = {
    id: nodeId,
    type: 'agent-identity',
    brain: `agent-brain/${agentName}`,
    created: createdDate,
    agent: agentName,
    relevance_keywords: keywords,
    hot: true,
  };

  return { nodeId, frontmatter, body: firstLine };
}

function serializeNode(frontmatter, body) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k}: [${v.map(s => `"${s}"`).join(', ')}]`;
      }
      return `${k}: ${v}`;
    })
    .join('\n');

  return `---\n${fm}\n---\n\n${body}`;
}

function seedAgent(agentName, dryRun) {
  const createdDate = new Date().toISOString().slice(0, 10);

  try {
    const content = readAgentDefinition(agentName);
    const { frontmatter: fm, body } = parseFrontmatter(content);

    let sections = extractSections(body);
    // For agents without subsections, create a behavior section from the body
    if (sections.length === 0) {
      sections = [{
        header: 'Behavior',
        content: body.trim(),
      }];
    }

    const brainDir = join(agentMemoryRoot(), 'nexus', 'agent-brain', agentName);
    const nodesDir = join(brainDir, 'nodes');
    const graphPath = join(brainDir, 'graph.json');

    let graph = emptyGraph(`agent-brain/${agentName}`, agentName);

    // Create identity node
    const identityNode = createIdentityNode(agentName, body, fm, createdDate);
    graph = addNode(graph, identityNode.nodeId);

    if (!dryRun) {
      mkdirSync(nodesDir, { recursive: true });
      const identityPath = join(nodesDir, `${identityNode.nodeId}.md`);
      const identityContent = serializeNode(identityNode.frontmatter, identityNode.body);
      writeFileSync(identityPath, identityContent, 'utf8');
    }

    // Create section nodes
    for (const section of sections) {
      const node = createSectionNode(agentName, section, createdDate);
      graph = addNode(graph, node.nodeId);

      if (!dryRun) {
        const nodePath = join(nodesDir, `${node.nodeId}.md`);
        const nodeContent = serializeNode(node.frontmatter, node.body);
        writeFileSync(nodePath, nodeContent, 'utf8');
      }

      // Connect identity -> section
      graph = addEdge(graph, identityNode.nodeId, node.nodeId);
    }

    if (!dryRun) {
      writeGraph(graphPath, graph);
    }

    return {
      success: true,
      nodesCount: graph.nodes.length,
      edgesCount: graph.edges.length,
    };
  } catch (err) {
    console.error(`  [error] ${err.message}`);
    return { success: false, nodesCount: 0, edgesCount: 0, error: err.message };
  }
}

function main() {
  const args = parseArgs(process.argv);

  const agentsToSeed = args.all ? AGENTS : (args.agent ? [args.agent] : []);

  if (agentsToSeed.length === 0) {
    console.error('Usage: node tools/agent-brain-seed.js [--agent=<name>] [--all] [--dry-run]');
    process.exit(1);
  }

  if (args.dryRun) {
    console.log('[dry-run mode]\n');
  }

  for (const agentName of agentsToSeed) {
    if (!AGENTS.includes(agentName)) {
      console.error(`Unknown agent: ${agentName}`);
      process.exit(1);
    }

    const result = seedAgent(agentName, args.dryRun);
    if (result.success) {
      console.log(`seeded ${agentName}: ${result.nodesCount} nodes, ${result.edgesCount} edges`);
    } else {
      console.error(`failed to seed ${agentName}: ${result.error || 'unknown error'}`);
      process.exit(1);
    }
  }
}

if (isMainModule(import.meta.url)) main();
