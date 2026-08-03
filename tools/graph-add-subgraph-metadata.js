#!/usr/bin/env node

/**
 * graph-add-subgraph-metadata.js
 *
 * Adds group/subgraph metadata to node frontmatter for Obsidian visual organization.
 * Categorizes nodes and adds a "group" field that can be used for filtering.
 *
 * Usage:
 *   node graph-add-subgraph-metadata.js [--apply]
 */

import fs from 'fs';
import path from 'path';

const NEXUS_DIR = path.join(process.env.USERPROFILE || process.env.HOME, 'agent-memory', 'nexus');

const SUBGRAPH_MAPPING = {
  'personal': 'Personal',
  'arbor-genie': 'Arbor Genie',
  'basely': 'Basely',
  'patchmypc': 'PatchMyPC',
  'agent': 'Agents',
  'workflow': 'Workflow',
  'preferences': 'Preferences',
  'patterns': 'Patterns',
  'patterns-uncategorized': 'Patterns'
};

function categorizeNode(nodeId) {
  if (nodeId.startsWith('nathan-') || nodeId.startsWith('nathans-')) return 'personal';
  if (nodeId.startsWith('arbor-genie-') || nodeId.startsWith('genie-')) return 'arbor-genie';
  if (nodeId.startsWith('basely-')) return 'basely';
  if (nodeId.startsWith('patchmypc-')) return 'patchmypc';
  if (nodeId.startsWith('agent-')) return 'agent';
  if (nodeId.match(/^(all-repos|prs-|branch-|commit-)/)) return 'workflow';
  if (nodeId.match(/^(asking-for|long-summaries|rebuilding-)/)) return 'preferences';
  if (nodeId.startsWith('manual-') || nodeId.startsWith('daily-') || nodeId.startsWith('template-')) return 'patterns';
  // Agent-specific nodes
  if (nodeId.startsWith('friday-')) return 'agent';
  if (nodeId.startsWith('jarvis-')) return 'agent';
  if (nodeId.startsWith('sam-')) return 'agent';
  if (nodeId.startsWith('leo-')) return 'agent';
  if (nodeId.startsWith('nat-') && !nodeId.startsWith('nathan-')) return 'agent';
  if (nodeId.startsWith('pym-')) return 'agent';
  if (nodeId.startsWith('astra-')) return 'agent';
  if (nodeId.startsWith('wanda-')) return 'agent';
  if (nodeId.startsWith('ultron-')) return 'agent';
  if (nodeId.startsWith('r2d2-')) return 'agent';
  if (nodeId.startsWith('threepio-')) return 'agent';
  return 'patterns';
}

function addGroupMetadata(nodeId, content) {
  const category = categorizeNode(nodeId);
  const group = SUBGRAPH_MAPPING[category] || 'Other';

  // Check if group already exists
  if (content.includes('group:')) {
    return null; // Already has group
  }

  // Add group field to frontmatter
  const lines = content.split('\n');
  let frontmatterEnd = -1;

  // Find end of frontmatter
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith('---')) {
      frontmatterEnd = i;
      break;
    }
  }

  if (frontmatterEnd === -1) {
    console.error(`  ✗ ${nodeId}: no frontmatter closing ---`);
    return null;
  }

  // Insert group before closing ---
  lines.splice(frontmatterEnd, 0, `group: ${group}`);

  return lines.join('\n');
}

function processNode(nodePath, nodeId) {
  try {
    const content = fs.readFileSync(nodePath, 'utf8');
    const updated = addGroupMetadata(nodeId, content);

    if (updated && updated !== content) {
      fs.writeFileSync(nodePath, updated, 'utf8');
      return { updated: true, group: categorizeNode(nodeId) };
    }
    return { updated: false };
  } catch (e) {
    console.error(`  ✗ Error processing ${nodeId}: ${e.message}`);
    return { updated: false };
  }
}

function processBrain(brainPath, brainName) {
  const nodesDir = path.join(brainPath, 'nodes');
  if (!fs.existsSync(nodesDir)) return 0;

  const nodeFiles = fs.readdirSync(nodesDir).filter(f => f.endsWith('.md'));
  let count = 0;

  nodeFiles.forEach(file => {
    const nodeId = file.replace('.md', '');
    const nodePath = path.join(nodesDir, file);
    const result = processNode(nodePath, nodeId);
    if (result.updated) {
      console.log(`  ✓ ${nodeId} → ${result.group}`);
      count++;
    }
  });

  return count;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const mode = apply ? 'APPLY' : 'DRY-RUN';
  console.log(`\n📊 Adding subgraph metadata (${mode})\n`);

  let totalUpdated = 0;

  // Process each brain
  console.log('📋 Personal brain:');
  totalUpdated += processBrain(path.join(NEXUS_DIR, 'personal-brain'), 'personal-brain');

  console.log('\n📋 Agent brain (global):');
  totalUpdated += processBrain(path.join(NEXUS_DIR, 'agent-brain'), 'agent-brain');

  // Per-agent brains
  const agentDirs = fs.readdirSync(path.join(NEXUS_DIR, 'agent-brain'))
    .filter(f => fs.statSync(path.join(NEXUS_DIR, 'agent-brain', f)).isDirectory() &&
                 fs.existsSync(path.join(NEXUS_DIR, 'agent-brain', f, 'nodes')));

  agentDirs.forEach(agent => {
    console.log(`\n📋 Agent brain/${agent}:`);
    totalUpdated += processBrain(path.join(NEXUS_DIR, 'agent-brain', agent), `agent-brain/${agent}`);
  });

  console.log(`\n✅ Added group metadata to ${totalUpdated} nodes.`);
  console.log(`\n💡 Obsidian graph view now supports filtering by group:`);
  console.log('   Graph view → Filters → Add filter → "group" → select category');
  console.log('\nAvailable groups:');
  Object.values(SUBGRAPH_MAPPING).forEach(g => console.log(`   - ${g}`));
}

await main();
