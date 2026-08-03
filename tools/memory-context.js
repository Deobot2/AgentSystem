#!/usr/bin/env node
// memory-context.js — three-layer scoped read for agent startup.
// Merges: (1) global user brain (hot index), (2) active-project brain (detected from cwd),
// (3) recent episodic (latest SONA patterns). One cheap, oriented load instead of ls+read.
// Usage: node tools/memory-context.js [--cwd=PATH] [--recent=3]

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { agentMemoryRoot, readGraph, parseFrontmatter, resolveRepoGraphPath } from './graph/graph-lib.js';
import { parseEntries, tfidfEmbedding, cosineSimilarity } from './memory-search.js';
import { isMainModule } from './is-main.js';

// Pure: find the repo whose path is a prefix of cwd (longest match wins). Returns the
// full registry entry (or null) so callers can also read brain_path etc.
export function detectRepo(cwd, registry) {
  const norm = p => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const c = norm(cwd);
  let best = null;
  for (const repo of registry.repos || []) {
    const rp = norm(repo.path);
    if (c === rp || c.startsWith(rp + '/')) {
      if (!best || rp.length > norm(best.path).length) best = repo;
    }
  }
  return best;
}

// Pure: find the repo whose path is a prefix of cwd (longest match wins). Returns slug or null.
export function detectProject(cwd, registry) {
  const repo = detectRepo(cwd, registry);
  return repo ? repo.slug : null;
}

// Pure: given an array of { id, importance, superseded_by? } objects (any order), return the top-N ids
// by descending importance, excluding superseded nodes. All facts remain queryable via graph-query; this is just the
// working-set cap for injected context (human working memory ≈ 4-7 chunks, Cowan 2001).
// Superseded nodes should be skipped to avoid injecting conflicting information.
export function selectCoreFacts(facts, n) {
  return facts
    .filter(f => !f.superseded_by) // Skip superseded nodes
    .slice()
    .sort((a, b) => b.importance - a.importance)
    .slice(0, n)
    .map(f => f.id);
}

// Pure: given parsed SONA entries + a query string, return top-N entry ids by TF-IDF relevance.
// scorer is injected (default: real TF-IDF) so unit tests can stub it without file IO.
// Falls back to empty array when no query or no entries.
export function relevantSona(entries, query, { top = 3, scorer = null } = {}) {
  if (!entries || entries.length === 0 || !query || !query.trim()) return [];
  const scoreFn = scorer ?? ((entry, q) => {
    const queryVec = tfidfEmbedding(q);
    return cosineSimilarity(queryVec, tfidfEmbedding(entry.text));
  });
  return entries
    .map(e => ({ id: e.id, score: scoreFn(e, query) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, top)
    .map(r => r.id);
}

// Leads get the fuller slice (still capped); everyone else is treated as a worker and gets
// repo facts + their own agent-brain nodes only — no personal user facts, minimal sona.
// See #120: workers routinely skip the "query memory manually" ritual, so this must be pushed.
const LEAD_AGENTS = new Set(['jarvis', 'friday', 'sam', 'nat']);

export function agentTier(agentName) {
  return LEAD_AGENTS.has((agentName || '').toLowerCase()) ? 'lead' : 'worker';
}

// Pure: scan agent-brain/nodes/*.md frontmatter for `agent: <agentName>` (or the agent's own
// identity node `agent-<agentName>`), return up to n ids, most-recent first.
export function agentBrainNodes(agentBrainDir, agentName, n = 3) {
  if (!agentName || !existsSync(agentBrainDir)) return [];
  const nodesDir = join(agentBrainDir, 'nodes');
  if (!existsSync(nodesDir)) return [];
  const name = agentName.toLowerCase();
  const identityId = `agent-${name}`;
  const matches = [];
  for (const file of readdirSyncSafe(nodesDir)) {
    if (!file.endsWith('.md')) continue;
    const id = file.slice(0, -3);
    let frontmatter;
    try {
      ({ frontmatter } = parseFrontmatter(readFileSync(join(nodesDir, file), 'utf8')));
    } catch { continue; }
    if (id === identityId || (frontmatter.agent || '').toLowerCase() === name) {
      matches.push({ id, created: frontmatter.created || '' });
    }
  }
  return matches
    .sort((a, b) => (a.id === identityId ? -1 : b.id === identityId ? 1 : (b.created > a.created ? 1 : -1)))
    .slice(0, n)
    .map(m => m.id);
}

function readdirSyncSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

function hotUserFacts(nexus) {
  const dir = join(nexus, 'personal-brain');
  const graphPath = join(dir, 'graph.json');
  if (!existsSync(graphPath)) return [];
  const graph = readGraph(graphPath);
  const out = [];
  for (const nodeId of graph.nodes) {
    const p = join(dir, 'nodes', `${nodeId}.md`);
    if (!existsSync(p)) continue;
    const { frontmatter } = parseFrontmatter(readFileSync(p, 'utf8'));
    if (frontmatter.hot === true) {
      out.push({
        id: nodeId,
        importance: parseFloat(frontmatter.importance ?? 0) || 0,
        superseded_by: frontmatter.superseded_by,
      });
    }
  }
  return out;
}

function recentSona(nexus, n) {
  const p = join(nexus, 'sona-patterns.md');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n')
    .filter(l => l.startsWith('### '))
    .slice(-n)
    .map(l => l.replace(/^###\s+/, '').trim());
}

// keywords: optional string — when provided, sona is ranked by relevance to slug + keywords;
// falls back to recency when no query signal is available.
export function buildContext({ cwd = process.cwd(), recent = 3, core = 7, keywords = '' } = {}) {
  const nexus = join(agentMemoryRoot(), 'nexus');
  const registryPath = join(nexus, 'known-repos.json');
  const registry = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf8')) : { repos: [] };
  const repo = detectRepo(cwd, registry);
  const slug = repo ? repo.slug : null;

  const allFacts = hotUserFacts(nexus);
  const userCore = selectCoreFacts(allFacts, core);
  const userTotal = allFacts.length;

  // Repo brains live IN the repo working tree, not under agentMemoryRoot() — see
  // resolveRepoGraphPath in graph-lib.js (single source of truth, shared with graph-query.js).
  const projectGraphPath = repo ? resolveRepoGraphPath(repo) : null;
  const projectNodes = projectGraphPath && existsSync(projectGraphPath) ? readGraph(projectGraphPath).nodes.length : 0;

  const query = [slug, keywords].filter(Boolean).join(' ').trim();
  let sona;
  if (query) {
    const sonaPath = join(nexus, 'sona-patterns.md');
    const entries = existsSync(sonaPath) ? parseEntries(readFileSync(sonaPath, 'utf8')) : [];
    const ids = relevantSona(entries, query, { top: recent });
    sona = ids.length > 0 ? ids : recentSona(nexus, recent);
  } else {
    sona = recentSona(nexus, recent);
  }

  return { slug, userCore, userTotal, projectNodes, sona };
}

// Character budget standing in for a token cap (~4 chars/token, conservative rounding down
// so 500 tokens of budget maps to ~1800 chars of rendered text — leaves headroom).
const SUBAGENT_CHAR_BUDGET = 1800;

// Builds the compact, tiered slice injected at SubagentStart (#120). Cheaper than buildContext:
// leads get a trimmed version of the same three layers; workers get repo facts + their own
// agent-brain nodes only (no personal user facts) to keep worker spawns memory-light and fast.
export function buildSubagentContext({ agent, cwd = process.cwd(), keywords = '' } = {}) {
  const tier = agentTier(agent);
  const nexus = join(agentMemoryRoot(), 'nexus');
  const registryPath = join(nexus, 'known-repos.json');
  const registry = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf8')) : { repos: [] };
  const repo = detectRepo(cwd, registry);
  const slug = repo ? repo.slug : null;

  const projectGraphPath = repo ? resolveRepoGraphPath(repo) : null;
  const projectNodes = projectGraphPath && existsSync(projectGraphPath) ? readGraph(projectGraphPath).nodes.length : 0;

  const agentBrainDir = join(nexus, 'agent-brain');
  const brainNodes = agentBrainNodes(agentBrainDir, agent, tier === 'lead' ? 5 : 3);

  let userCore = [];
  let userTotal = 0;
  let sona = [];

  if (tier === 'lead') {
    const allFacts = hotUserFacts(nexus);
    userTotal = allFacts.length;
    userCore = selectCoreFacts(allFacts, 4);

    const query = [slug, agent, keywords].filter(Boolean).join(' ').trim();
    const sonaPath = join(nexus, 'sona-patterns.md');
    const entries = existsSync(sonaPath) ? parseEntries(readFileSync(sonaPath, 'utf8')) : [];
    const ids = query ? relevantSona(entries, query, { top: 3 }) : [];
    sona = ids.length > 0 ? ids : recentSona(nexus, 3);
  } else {
    // Worker tier: no personal user facts, one recent sona pattern at most.
    sona = recentSona(nexus, 1);
  }

  return { agent, tier, slug, projectNodes, brainNodes, userCore, userTotal, sona };
}

function renderSubagent(ctx) {
  const lines = [];
  lines.push(`## Memory Context (${ctx.agent || 'agent'}, ${ctx.tier})`);
  if (ctx.slug) {
    lines.push(`Project [${ctx.slug}]: ${ctx.projectNodes} brain nodes — query: graph-query.js ${ctx.slug} <keywords>`);
  }
  if (ctx.brainNodes.length > 0) {
    lines.push(`Agent-brain: ${ctx.brainNodes.join(', ')}`);
  }
  if (ctx.tier === 'lead') {
    const remainder = ctx.userTotal - ctx.userCore.length;
    const moreHint = remainder > 0 ? ` (+${remainder} more)` : '';
    lines.push(`User (top ${ctx.userCore.length} of ${ctx.userTotal}): ${ctx.userCore.join(', ') || '(none)'}${moreHint}`);
  }
  if (ctx.sona.length > 0) {
    lines.push(`Recent patterns: ${ctx.sona.join(' | ')}`);
  }
  let out = lines.join('\n');
  if (out.length > SUBAGENT_CHAR_BUDGET) out = out.slice(0, SUBAGENT_CHAR_BUDGET - 3) + '...';
  return out;
}

// #122: compact single-block render (was 4 headed paragraphs w/ blank-line padding) — same
// facts, ~40% fewer bytes injected at SessionStart. Full querying instructions still available
// via graph-query.js directly; this only trims the inline prose around each fact line.
function render(ctx) {
  const remainder = ctx.userTotal - ctx.userCore.length;
  const moreHint = remainder > 0 ? ` (+${remainder} more)` : '';
  const project = ctx.slug
    ? `[${ctx.slug}] ${ctx.projectNodes} nodes`
    : 'not in a registered repo';
  return [
    '## Memory Context',
    `User (top ${ctx.userCore.length}/${ctx.userTotal}): ${ctx.userCore.join(', ') || '(none)'}${moreHint}`,
    `Project: ${project} — query: graph-query.js <slug> <keywords>`,
    `Recent: ${ctx.sona.join(' | ') || '(none)'}`,
  ].join('\n');
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  const flags = {};
  const bools = new Set();
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([\w-]+)=(.*)$/);
    if (m) { flags[m[1]] = m[2]; continue; }
    const b = a.match(/^--([\w-]+)$/);
    if (b) bools.add(b[1]);
  }
  if (bools.has('subagent')) {
    const ctx = buildSubagentContext({ agent: flags.agent || '', cwd: flags.cwd || process.cwd(), keywords: flags.keywords || '' });
    console.log(renderSubagent(ctx));
  } else {
    const ctx = buildContext({ cwd: flags.cwd || process.cwd(), recent: parseInt(flags.recent || '3'), core: parseInt(flags.core || '7') });
    console.log(render(ctx));
  }
}
