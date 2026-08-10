#!/usr/bin/env node
// graph-init.js — populate repo brain from git + file analysis
// Usage: node tools/graph/graph-init.js <project-slug> [repo-path]

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, relative, extname } from 'node:path';
import { homedir } from 'node:os';
import {
  emptyGraph, readGraph, writeGraph,
  addNode, addEdge, pruneOrphanedEdges,
  recomputeComposite, serializeFrontmatter,
} from './graph-lib.js';
import { isMainModule } from '../is-main.js';

function expandTilde(p) {
  return p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

function main() {
const rawArgs = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of rawArgs) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v ?? true;
  } else {
    positional.push(a);
  }
}

const [slug, repoPathArg] = positional;
const repoPath = resolve(expandTilde(repoPathArg) || process.cwd());
if (!slug) { console.error('Usage: graph-init.js <project-slug> [repo-path] [--brain-path=PATH]'); process.exit(1); }

// #346: a positional repo-path that is actually a BRAIN directory (personal-brain,
// agent-brain/<agent>) silently scaffolds a nested nexus/<slug>/ inside the brain instead of
// touching it — 40 stray nodes were reported as "graph-init: 40 nodes, 0 edges" while the real
// 302-node/123-edge brain sat untouched. Detect it two ways: it already holds a graph.json, or
// its own path ends in nexus/<slug> (the brain-path convention). Refuse rather than scaffold.
function looksLikeBrainDir(p) {
  if (existsSync(join(p, 'graph.json'))) return true;
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const nexusIdx = parts.lastIndexOf('nexus');
  return nexusIdx !== -1 && nexusIdx === parts.length - 2;
}

if (repoPathArg && looksLikeBrainDir(repoPath)) {
  console.error(
    `graph-init: refusing — "${repoPathArg}" resolves to ${repoPath}, which looks like a brain\n` +
    `directory (holds graph.json, or its path ends in nexus/<slug>), not a repo root.\n` +
    `Use --brain-path="${repoPathArg}" instead:\n` +
    `  node tools/graph/graph-init.js ${slug} --brain-path="${repoPathArg}"`
  );
  process.exit(1);
}

const nexusDir = flags['brain-path']
  ? resolve(expandTilde(flags['brain-path']))
  : join(repoPath, 'nexus', slug);
const nodesDir = join(nexusDir, 'nodes');
const graphPath = join(nexusDir, 'graph.json');

mkdirSync(nodesDir, { recursive: true });

let graph = existsSync(graphPath) ? readGraph(graphPath) : emptyGraph('repo', slug);
graph = { ...graph, brain: 'repo', project_slug: slug };

const today = new Date().toISOString().slice(0, 10);

function git(cmd) {
  try { return execSync(cmd, { cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch { return ''; }
}

function extractKeywords(text) {
  return [...new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !['the', 'and', 'for', 'from', 'with'].includes(w))
      .slice(0, 6)
  )];
}

// ── Step 1: Commit nodes ──────────────────────────────────────────────────────
const logRaw = git('git log --oneline --no-merges -50');
for (const line of logRaw.trim().split('\n').filter(Boolean)) {
  const [hash, ...rest] = line.split(' ');
  const msg = rest.join(' ');
  const nodeId = `commit-${hash}`;
  if (!existsSync(join(nodesDir, `${nodeId}.md`))) {
    const fm = {
      id: nodeId, type: 'commit', brain: 'repo', created: today,
      relevance_keywords: extractKeywords(msg), connections: [],
    };
    writeFileSync(
      join(nodesDir, `${nodeId}.md`),
      serializeFrontmatter(fm, `# Commit: ${hash}\n\n${msg}\n`),
      'utf8'
    );
  }
  graph = addNode(graph, nodeId);
}

// ── Step 2: Hotfile nodes ─────────────────────────────────────────────────────
const statRaw = git('git log --name-only --no-merges --format="" -200');
const fileCounts = {};
for (const line of statRaw.trim().split('\n').filter(Boolean)) {
  if (line.trim()) fileCounts[line.trim()] = (fileCounts[line.trim()] || 0) + 1;
}
const maxCount = Math.max(...Object.values(fileCounts), 1);
const hotfiles = Object.entries(fileCounts).sort((a, b) => b[1] - a[1]).slice(0, 20);

for (const [filePath, count] of hotfiles) {
  const nodeId = `hotfile-${filePath.replace(/[^a-zA-Z0-9]/g, '-')}`;
  const churnScore = parseFloat((count / maxCount).toFixed(4));
  const ext = extname(filePath).slice(1) || 'unknown';
  if (!existsSync(join(nodesDir, `${nodeId}.md`))) {
    const fm = {
      id: nodeId, type: 'hotfile', brain: 'repo', created: today,
      churn_score: churnScore, path: filePath,
      relevance_keywords: [filePath.split('/').pop(), ext], connections: [],
    };
    writeFileSync(
      join(nodesDir, `${nodeId}.md`),
      serializeFrontmatter(fm, `# Hot File: ${filePath}\n\nChurn: ${churnScore} (${count} changes)\n`),
      'utf8'
    );
  }
  graph = addNode(graph, nodeId);
}

// ── Step 3: File nodes + semantic edges ──────────────────────────────────────
const SOURCE_EXTS = new Set(['.js', '.ts', '.py', '.ps1', '.sh', '.jsx', '.tsx', '.mjs']);
const IMPORT_RE = /(?:import|require|from)\s+['"]([^'"]+)['"]/g;

function scanFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const fullPath = join(dir, e.name);
      if (e.isDirectory() && !['node_modules', '.git', '.claude', 'nexus'].includes(e.name))
        return scanFiles(fullPath);
      if (e.isFile() && SOURCE_EXTS.has(extname(e.name)))
        return [fullPath];
      return [];
    });
  } catch { return []; }
}

const sourceFiles = scanFiles(repoPath);
const fileNodeMap = {};

for (const filePath of sourceFiles) {
  const rel = relative(repoPath, filePath);
  const nodeId = `file-${rel.replace(/[^a-zA-Z0-9]/g, '-')}`;
  fileNodeMap[filePath] = nodeId;
  graph = addNode(graph, nodeId);
  if (!existsSync(join(nodesDir, `${nodeId}.md`))) {
    const fm = {
      id: nodeId, type: 'file', brain: 'repo', created: today,
      path: rel, relevance_keywords: extractKeywords(rel), connections: [],
    };
    writeFileSync(
      join(nodesDir, `${nodeId}.md`),
      serializeFrontmatter(fm, `# File: ${rel}\n\nPath: \`${rel}\`\n`),
      'utf8'
    );
  }
}

for (const filePath of sourceFiles) {
  try {
    const content = readFileSync(filePath, 'utf8');
    const sourceId = fileNodeMap[filePath];
    let match;
    IMPORT_RE.lastIndex = 0;
    while ((match = IMPORT_RE.exec(content)) !== null) {
      if (match[1].startsWith('.')) {
        const base = join(filePath, '..');
        for (const ext of ['', '.js', '.mjs', '.ts', '/index.js']) {
          const candidate = resolve(base, match[1] + ext);
          if (fileNodeMap[candidate]) {
            graph = addEdge(graph, sourceId, fileNodeMap[candidate]);
            const tgt = fileNodeMap[candidate];
            graph = { ...graph, edges: graph.edges.map(e =>
              e.source === sourceId && e.target === tgt
                ? { ...e, weights: { ...e.weights, semantic: 0.85 }, composite: recomputeComposite({ ...e.weights, semantic: 0.85 }) }
                : e
            )};
            break;
          }
        }
      }
    }
  } catch { /* skip unreadable */ }
}

// ── Step 4: Co-change edges ───────────────────────────────────────────────────
const logFiles = git('git log --name-only --no-merges --format="COMMIT" -100');
let commitFiles = [];
for (const line of logFiles.split('\n')) {
  if (line.trim() === 'COMMIT') {
    const nodeIds = commitFiles
      .map(f => fileNodeMap[join(repoPath, f)])
      .filter(Boolean);
    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        graph = addEdge(graph, nodeIds[i], nodeIds[j]);
        const srcId = nodeIds[i];
        const tgtId = nodeIds[j];
        graph = { ...graph, edges: graph.edges.map(e =>
          (e.source === srcId && e.target === tgtId) || (e.source === tgtId && e.target === srcId)
            ? { ...e, weights: { ...e.weights, _co_raw: (e.weights._co_raw || 0) + 1 } }
            : e
        )};
      }
    }
    commitFiles = [];
  } else if (line.trim()) {
    commitFiles.push(line.trim());
  }
}
const maxCoRaw = Math.max(...graph.edges.map(e => e.weights._co_raw || 0), 1);
graph = { ...graph, edges: graph.edges.map(e =>
  e.weights._co_raw
    ? { ...e,
        weights: { ...e.weights, co_change: parseFloat(((e.weights._co_raw || 0) / maxCoRaw).toFixed(4)) },
        composite: recomputeComposite({ ...e.weights, co_change: parseFloat(((e.weights._co_raw || 0) / maxCoRaw).toFixed(4)) })
      }
    : e
)};


// ── Step 5: Arch nodes ────────────────────────────────────────────────────────
const docsDir = join(repoPath, 'docs');
if (existsSync(docsDir)) {
  for (const file of readdirSync(docsDir).filter(f => f.match(/^ADR|arch/i) && f.endsWith('.md'))) {
    const nodeId = `arch-${file.replace(/[^a-zA-Z0-9]/g, '-').replace(/-md$/, '')}`;
    graph = addNode(graph, nodeId);
    if (!existsSync(join(nodesDir, `${nodeId}.md`))) {
      let body = '';
      try { body = readFileSync(join(docsDir, file), 'utf8'); } catch { /* ignore */ }
      const fm = {
        id: nodeId, type: 'arch', brain: 'repo', created: today,
        source_file: `docs/${file}`, relevance_keywords: extractKeywords(file), connections: [],
      };
      writeFileSync(join(nodesDir, `${nodeId}.md`), serializeFrontmatter(fm, body), 'utf8');
    }
  }
}

// ── Finalise ──────────────────────────────────────────────────────────────────
graph = pruneOrphanedEdges(graph);
writeGraph(graphPath, graph);

const commitCount = graph.nodes.filter(n => n.startsWith('commit-')).length;
const fileCount = graph.nodes.filter(n => n.startsWith('file-')).length;
const hotfileCount = graph.nodes.filter(n => n.startsWith('hotfile-')).length;
const archCount = graph.nodes.filter(n => n.startsWith('arch-')).length;

const topEdges = graph.edges
  .sort((a, b) => b.composite - a.composite)
  .slice(0, 10)
  .map(e => `- \`${e.source}\` → \`${e.target}\` (${e.composite})`)
  .join('\n');

writeFileSync(
  join(nexusDir, 'INDEX.md'),
  `# Repo Brain Index — ${slug}\n\nGenerated: ${today}\nNodes: ${graph.nodes.length} | Edges: ${graph.edges.length}\n\n## Node Types\n- Commits: ${commitCount}\n- Files: ${fileCount}\n- Hot files: ${hotfileCount}\n- Architecture: ${archCount}\n\n## Top Edges by Composite Score\n${topEdges || '(none)'}\n`,
  'utf8'
);

console.log(`graph-init: ${graph.nodes.length} nodes, ${graph.edges.length} edges → ${nexusDir}`);
}

if (isMainModule(import.meta.url)) main();
