#!/usr/bin/env node
// brain-remember.js — agent-driven write-back (MemGPT-style self-edit).
// Agents call this when they learn a durable fact. Routes to one of three tiers:
//   - personal (default): user-brain.md → splitPersonalBrain() → personal-brain/nodes/*.md
//   - repo:    <repo-path>/nexus/<slug>/graph.json (auto-inits via graph-init.js on first use)
//   - agent:   ~/agent-memory/nexus/agent-brain/graph.json, edged to agent-<name>
// All three tiers sync wikilinks immediately after every write (no weekly-cron wait).
// Usage: node tools/brain-remember.js --fact="..." [--section="..."] [--tier=repo --target="agentsystem"]

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  agentMemoryRoot, computeSalience,
  addNode, addEdge, readGraph, writeGraph, emptyGraph, serializeFrontmatter,
} from './graph/graph-lib.js';
import { splitPersonalBrain } from './personal-brain-split.js';
import { reconcileFact, defaultLlm } from './memory-reconcile.js';
import { readRegistry, findRepo } from './graph/known-repos.js';
import { buildWikilinkMap, applyWikilinkMap } from './graph/wikilink-sync.js';
import { findHighOverlapCandidates, loadNodesForSearch, markSuperseded } from './similarity-search.js';
import { isMainModule } from './is-main.js';

const GRAPH_INIT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'graph', 'graph-init.js');

// Shared slug logic — matches personal-brain-split.js's slugify() exactly (same regex),
// kept local here since it's also needed for repo/agent node ids and salience stamping.
function slugifyFact(text) {
  return text.replace(/^[-*]\s*/, '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '').trim()
    .split(/\s+/).slice(0, 8).join('-');
}

// Stamp salience onto a node file written by splitPersonalBrain.
// Non-fatal: if the node file is absent (slug mismatch etc.) we silently skip.
function stampSalience(fact, action) {
  const id = slugifyFact(fact);
  if (!id) return;
  const nodePath = join(agentMemoryRoot(), 'nexus', 'personal-brain', 'nodes', `${id}.md`);
  if (!existsSync(nodePath)) return;
  try {
    const raw = readFileSync(nodePath, 'utf8');
    const presolveConfidence = action === 'UPDATE' ? 0.5 : 0.1;
    const salience = computeSalience({ firstTimeSolve: action === 'ADD', presolveConfidence });
    if (raw.includes('\nsalience:')) return;
    const stamped = raw.replace(/^---\n/, `---\nsalience: ${salience}\n`);
    writeFileSync(nodePath, stamped, 'utf8');
  } catch (e) {
    // Non-fatal: salience stamping never blocks fact persistence, but a silent swallow
    // here previously made stamping failures invisible (#144). Surface to stderr so
    // recurring failures (bad frontmatter, permissions, etc.) are diagnosable.
    console.error(`brain-remember: stampSalience failed for "${fact}": ${e.message}`);
  }
}

// Non-fatal: link sync never blocks fact persistence (mirrors stampSalience's contract).
function syncWikilinks(brainDir) {
  try {
    const graphPath = join(brainDir, 'graph.json');
    if (!existsSync(graphPath)) return;
    const graph = readGraph(graphPath);
    const map = buildWikilinkMap(graph);
    applyWikilinkMap(map, join(brainDir, 'nodes'));
  } catch (e) {
    // Non-fatal: link sync never blocks fact persistence (mirrors stampSalience's
    // contract), but surface the failure so a broken wikilink pass is discoverable (#144).
    console.error(`brain-remember: syncWikilinks failed for ${brainDir}: ${e.message}`);
  }
}

// Detect and mark contradictions in a brain's graph.
// Returns the ID of the superseded node (if any).
// Non-fatal: contradiction detection never blocks fact persistence.
function detectAndMarkContradictions(newFact, graph, nodesDir, newNodeId) {
  try {
    const { similarityThreshold = 0.45 } = {};
    const existingNodes = loadNodesForSearch(nodesDir, graph.nodes);
    const candidates = findHighOverlapCandidates(newFact, existingNodes, { top: 3, similarityThreshold });

    // Find a contradicting candidate (high similarity + conflicting polarity)
    for (const candidate of candidates) {
      if (candidate.hasConflict) {
        // Mark the old node as superseded
        const oldNodePath = join(nodesDir, `${candidate.nodeId}.md`);
        if (existsSync(oldNodePath)) {
          const content = readFileSync(oldNodePath, 'utf8');
          const supersededContent = markSuperseded(content, newNodeId);
          writeFileSync(oldNodePath, supersededContent, 'utf8');
        }
        return candidate.nodeId; // Return the ID of the superseded node
      }
    }
  } catch (e) {
    // Non-fatal: contradiction detection never blocks persistence, but a silent
    // swallow made broken supersession invisible (#144) — surface it to stderr.
    console.error(`brain-remember: detectAndMarkContradictions failed: ${e.message}`);
  }
  return null;
}

// Resolve (and auto-init if missing) the on-disk location of a repo's brain.
// Returns null if the slug isn't registered or its registered path no longer exists.
function ensureRepoGraph(slug) {
  const registryPath = join(agentMemoryRoot(), 'nexus', 'known-repos.json');
  const registry = readRegistry(registryPath);
  const repo = findRepo(registry, slug);
  if (!repo || !existsSync(repo.path)) return null;

  const nexusDir = join(repo.path, 'nexus', slug);
  const graphPath = join(nexusDir, 'graph.json');
  if (!existsSync(graphPath)) {
    try {
      execFileSync(process.execPath, [GRAPH_INIT_PATH, slug, repo.path], { stdio: 'pipe', timeout: 60000 });
    } catch (e) {
      // Non-fatal: even if graph-init fails (e.g. not a git repo), fall through —
      // the caller still gets a writable target for the manual fact via emptyGraph().
      // Surfaced to stderr (#144) so a persistently-failing auto-init is diagnosable.
      console.error(`brain-remember: graph-init failed for slug "${slug}": ${e.message}`);
    }
  }
  return { nexusDir, graphPath, nodesDir: join(nexusDir, 'nodes') };
}

// tier: 'repo' — addNode only (no natural single anchor node to edge against; see plan's
// Global Constraints for why this differs from the agent-tier path).
function writeRepoFact({ fact, section, target }) {
  const loc = ensureRepoGraph(target);
  if (!loc) return { ok: false, added: false, message: `repo '${target}' registered but path missing — skipped` };

  const id = `manual-${slugifyFact(fact)}`;
  let graph = existsSync(loc.graphPath) ? readGraph(loc.graphPath) : emptyGraph('repo', target);
  const isNew = !graph.nodes.includes(id);
  graph = addNode(graph, id);

  mkdirSync(loc.nodesDir, { recursive: true });
  const nodeFile = join(loc.nodesDir, `${id}.md`);
  if (!existsSync(nodeFile)) {
    const today = new Date().toISOString().slice(0, 10);
    const fm = {
      id, type: 'manual-fact', brain: 'repo', source: 'manual-onboard',
      created: today, source_section: section, connections: [],
    };
    writeFileSync(nodeFile, serializeFrontmatter(fm, `- ${fact}`), 'utf8');
  }

  // Detect and mark contradictions (non-fatal)
  const supersededId = detectAndMarkContradictions(fact, graph, loc.nodesDir, id);

  writeGraph(loc.graphPath, graph);
  syncWikilinks(loc.nexusDir);
  return { ok: true, added: isNew, action: isNew ? 'ADD' : 'NOOP', id, supersededId };
}

// tier: 'agent' — addNode + addEdge to the existing agent-<target> identity node.
function writeAgentFact({ fact, section, target }) {
  const brainDir = join(agentMemoryRoot(), 'nexus', 'agent-brain');
  const graphPath = join(brainDir, 'graph.json');
  const nodesDir = join(brainDir, 'nodes');
  const agentNodeId = `agent-${target}`;

  let graph = existsSync(graphPath) ? readGraph(graphPath) : emptyGraph('agent', 'agent-brain');
  const id = `manual-${slugifyFact(fact)}`;
  const isNew = !graph.nodes.includes(id);
  graph = addNode(graph, id);
  if (graph.nodes.includes(agentNodeId)) graph = addEdge(graph, agentNodeId, id);

  mkdirSync(nodesDir, { recursive: true });
  const nodeFile = join(nodesDir, `${id}.md`);
  if (!existsSync(nodeFile)) {
    const today = new Date().toISOString().slice(0, 10);
    const fm = {
      id, type: 'manual-fact', brain: 'agent-brain', source: 'manual-onboard',
      created: today, source_section: section, agent: target, connections: [],
    };
    writeFileSync(nodeFile, serializeFrontmatter(fm, `- ${fact}`), 'utf8');
  }

  // Detect and mark contradictions (non-fatal)
  const supersededId = detectAndMarkContradictions(fact, graph, nodesDir, id);

  writeGraph(graphPath, graph);
  syncWikilinks(brainDir);
  return { ok: true, added: isNew, action: isNew ? 'ADD' : 'NOOP', id, supersededId };
}

// Pure: insert a fact bullet under `section` in markdown `raw`.
// Dedup: skips if the same fact text already exists (case-insensitive). Creates section if missing.
// Returns { md, added }.
export function appendFactToBrain(raw, fact, section = 'Session Notes') {
  const clean = fact.replace(/^[-*]\s*/, '').trim();
  if (!clean) return { md: raw, added: false };
  const bullet = `- ${clean}`;

  const lines = raw.split('\n');
  const norm = s => s.replace(/^[-*]\s*/, '').trim().toLowerCase();
  if (lines.some(l => norm(l) === norm(bullet))) return { md: raw, added: false };

  const headerIdx = lines.findIndex(l => {
    const m = l.match(/^#{1,3}\s+(.+?)\s*$/);
    return m && m[1].toLowerCase() === section.toLowerCase();
  });

  if (headerIdx === -1) {
    const tail = raw.endsWith('\n') ? '' : '\n';
    return { md: `${raw}${tail}\n## ${section}\n\n${bullet}\n`, added: true };
  }

  let end = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^#{1,3}\s+/.test(lines[i])) { end = i; break; }
  }
  let insertAt = headerIdx + 1;
  for (let i = headerIdx + 1; i < end; i++) {
    if (lines[i].trim() !== '') insertAt = i + 1;
  }
  lines.splice(insertAt, 0, bullet);
  return { md: lines.join('\n'), added: true };
}

export function remember({ fact, section = 'Session Notes', llm, tier = 'personal', target = '' } = {}) {
  if (!fact) return { ok: false, message: 'no fact provided', added: false };

  if (tier === 'repo') return writeRepoFact({ fact, section, target });
  if (tier === 'agent') return writeAgentFact({ fact, section, target });

  // tier === 'personal' (default) — unchanged behavior, now also syncs wikilinks.
  const brainPath = join(agentMemoryRoot(), 'nexus', 'personal-brain', 'user-brain.md');
  if (!existsSync(brainPath)) return { ok: false, message: 'user-brain.md not found', added: false };

  const raw = readFileSync(brainPath, 'utf8');
  const { md, action, supersededText } = reconcileFact(raw, fact, section, { llm: llm ?? defaultLlm });
  if (action === 'NOOP') return { ok: true, added: false, action: 'NOOP', message: 'already known (deduped)' };

  writeFileSync(brainPath, md, 'utf8');
  const split = splitPersonalBrain();
  stampSalience(fact, action);
  syncWikilinks(join(agentMemoryRoot(), 'nexus', 'personal-brain'));
  return { ok: true, added: true, action, section, supersededText, split, salience: true };
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const flags = {};
  for (const a of args) {
    const m = a.match(/^--([\w-]+)=(.*)$/);
    if (m) flags[m[1]] = m[2];
  }
  if (!flags.fact) {
    console.error('Usage: brain-remember.js --fact="..." [--section="..."] [--tier=repo|agent --target="..."]');
    process.exit(1);
  }
  const r = remember({ fact: flags.fact, section: flags.section, tier: flags.tier, target: flags.target });
  if (!r.ok) { console.error(`brain-remember: ${r.message}`); process.exit(1); }
  const tierLabel = flags.tier && flags.tier !== 'personal' ? `${flags.tier}:${flags.target}` : (flags.section || 'Session Notes');
  console.log(r.added ? `remembered → [${tierLabel}]: ${flags.fact}` : `brain-remember: ${r.message || 'no-op'}`);
}
