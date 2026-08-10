#!/usr/bin/env node
// memory-eval.js — retrieval evaluation harness for the graph-brain memory system.
// Closes the third leg of the memory feedback loop: a deterministic, fixture-based check that
// graph-query.js's BM25 retrieval actually returns the expected nodes for known queries, so a
// scoring/ranking regression fails CI instead of silently degrading every hook injection.
//
// No npm deps — Node builtins only; drives tools/graph/graph-query.js as a subprocess exactly
// the way hooks/memory-router.js does in production.
//
// Usage:
//   node tools/memory-eval.js            — build fixture brain in a temp dir, run canned
//                                          queries, print recall@1/recall@3, exit 1 if any
//                                          expected node misses recall@3
//   node tools/memory-eval.js --report   — summarize ~/agent-memory/nexus/injection-feedback.jsonl
//                                          (usefulness rate of injected memories, per brain)

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GRAPH_QUERY = join(__dirname, 'graph', 'graph-query.js');
const FEEDBACK_LOG = join(homedir(), 'agent-memory', 'nexus', 'injection-feedback.jsonl');

// Fixture: small brain with clearly separable topics so expected retrieval is unambiguous.
const FIXTURE_NODES = [
  {
    id: 'prefers-typescript-strict-mode',
    keywords: ['typescript', 'strict', 'compiler'],
    importance: 0.7,
    body: 'User prefers TypeScript strict mode enabled on every project. Never disable strict compiler checks.',
  },
  {
    id: 'deploy-only-via-github-actions',
    keywords: ['deploy', 'github', 'actions', 'pipeline'],
    importance: 0.8,
    body: 'Deployments must go through the GitHub Actions pipeline. Manual production deploys are forbidden.',
  },
  {
    id: 'postgres-is-the-only-database',
    keywords: ['postgres', 'database', 'sql'],
    importance: 0.6,
    body: 'Postgres is the only database in use. All schema changes go through Prisma migrations.',
  },
  {
    id: 'weekly-report-every-friday',
    keywords: ['weekly', 'report', 'friday'],
    importance: 0.4,
    body: 'A weekly status report is written every Friday summarizing shipped work.',
  },
  {
    id: 'never-force-push-to-main',
    keywords: ['force', 'push', 'main', 'git'],
    importance: 0.9,
    body: 'Never force push to the main branch. History on main is immutable.',
  },
];

export const FIXTURE_QUERIES = [
  { keywords: ['typescript', 'strict', 'settings'], expect: 'prefers-typescript-strict-mode' },
  { keywords: ['deploy', 'production', 'pipeline'], expect: 'deploy-only-via-github-actions' },
  { keywords: ['database', 'schema', 'migrations'], expect: 'postgres-is-the-only-database' },
  { keywords: ['force', 'push', 'main'], expect: 'never-force-push-to-main' },
];

// Build a minimal but schema-complete brain (graph.json + nodes/*.md) that graph-query.js
// accepts. Edge shape mirrors real brains (weights + composite) — a bare chain is enough.
export function buildFixtureBrain(dir) {
  const nodesDir = join(dir, 'nodes');
  mkdirSync(nodesDir, { recursive: true });
  const now = new Date().toISOString();
  const edges = [];
  for (let i = 0; i < FIXTURE_NODES.length - 1; i++) {
    edges.push({
      source: FIXTURE_NODES[i].id,
      target: FIXTURE_NODES[i + 1].id,
      weights: {
        co_change: 0, semantic: 0, _visit_raw: 1, visit_count: 0.001,
        last_visited: now, confidence: { n_confirms: 0, n_contradicts: 0 },
        valid_from: now, valid_until: null,
      },
      composite: 0.15,
    });
  }
  writeFileSync(join(dir, 'graph.json'), JSON.stringify({
    version: 1, brain: 'memory-eval-fixture', project_slug: 'memory-eval-fixture',
    nodes: FIXTURE_NODES.map(n => n.id), edges,
  }, null, 2) + '\n');
  for (const n of FIXTURE_NODES) {
    writeFileSync(join(nodesDir, `${n.id}.md`), [
      '---',
      `id: ${n.id}`,
      'type: user-fact',
      'brain: memory-eval-fixture',
      `relevance_keywords: [${n.keywords.join(', ')}]`,
      `importance: ${n.importance}`,
      '---',
      '',
      `- ${n.body}`,
      '',
    ].join('\n'));
  }
  return dir;
}

// Run one query against a brain dir via graph-query.js, return ranked node ids.
export function queryFixture(brainDir, keywords, top = 3) {
  const out = execFileSync(process.execPath,
    [GRAPH_QUERY, 'memory-eval-fixture', ...keywords, `--top=${top}`, '--json', `--brain-path=${brainDir}`],
    { encoding: 'utf8', timeout: 10000 });
  const parsed = JSON.parse(out);
  const direct = Array.isArray(parsed) ? parsed : (parsed.direct || []);
  return direct.map(r => (typeof r === 'string' ? r : r.nodeId));
}

// Evaluate all canned queries: recall@1 and recall@3 plus per-query detail.
export function runEval(brainDir) {
  const results = FIXTURE_QUERIES.map(q => {
    let ranked = [];
    try { ranked = queryFixture(brainDir, q.keywords); } catch { /* counts as a miss */ }
    return {
      keywords: q.keywords, expect: q.expect, ranked,
      hitAt1: ranked[0] === q.expect,
      hitAt3: ranked.slice(0, 3).includes(q.expect),
    };
  });
  const n = results.length;
  return {
    results,
    recallAt1: results.filter(r => r.hitAt1).length / n,
    recallAt3: results.filter(r => r.hitAt3).length / n,
  };
}

// --report: usefulness rate from injection-feedback.jsonl (written by injection-feedback-hook).
export function feedbackReport(logPath = FEEDBACK_LOG) {
  const stats = new Map(); // brain -> {injected, used}
  if (!existsSync(logPath)) return { total: 0, used: 0, rate: null, byBrain: {} };
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const brain = rec.brain || 'unknown';
    if (!stats.has(brain)) stats.set(brain, { injected: 0, used: 0 });
    const s = stats.get(brain);
    s.injected++;
    if (rec.used) s.used++;
  }
  const byBrain = Object.fromEntries(stats);
  const total = [...stats.values()].reduce((a, s) => a + s.injected, 0);
  const used = [...stats.values()].reduce((a, s) => a + s.used, 0);
  return { total, used, rate: total ? used / total : null, byBrain };
}

function main() {
  if (process.argv.includes('--report')) {
    const r = feedbackReport();
    console.log(`injection feedback: ${r.used}/${r.total} injected nodes used` +
      (r.rate !== null ? ` (${(r.rate * 100).toFixed(0)}%)` : ' (no data yet)'));
    for (const [brain, s] of Object.entries(r.byBrain)) {
      console.log(`  ${brain}: ${s.used}/${s.injected}`);
    }
    process.exit(0);
  }

  const dir = buildFixtureBrain(mkdtempSync(join(tmpdir(), 'memory-eval-')));
  const { results, recallAt1, recallAt3 } = runEval(dir);
  for (const r of results) {
    const mark = r.hitAt3 ? (r.hitAt1 ? 'PASS@1' : 'PASS@3') : 'MISS  ';
    console.log(`${mark} [${r.keywords.join(' ')}] expected=${r.expect} got=[${r.ranked.join(', ')}]`);
  }
  console.log(`recall@1=${recallAt1.toFixed(2)} recall@3=${recallAt3.toFixed(2)}`);
  process.exit(recallAt3 === 1 ? 0 : 1);
}

if (isMainModule(import.meta.url)) main();
