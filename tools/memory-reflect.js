#!/usr/bin/env node
// memory-reflect.js — Generative Agents-style reflection.
// Reads the highest-importance user facts, asks an LLM for higher-level insights
// (patterns not explicitly stated), and writes them back as durable brain facts via
// brain-remember (so they flow through the single source of truth, user-brain.md).
// LLM call uses `claude -p` (subscription, no API key). Injectable for testing.
// Usage: node tools/memory-reflect.js [--top=10] [--dry-run]

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { execFileSync } from 'node:child_process';
import { agentMemoryRoot, readGraph, parseFrontmatter } from './graph/graph-lib.js';
import { remember } from './brain-remember.js';
import { isMainModule } from './is-main.js';

// Pure: build the reflection prompt from selected fact texts.
export function buildReflectionPrompt(facts) {
  return [
    'Here are facts about a user, ranked by importance:',
    '',
    ...facts.map(f => `- ${f}`),
    '',
    'Generate up to 3 higher-level INSIGHTS: generalizations or patterns that are implied',
    'but NOT explicitly stated above. Each must be genuinely new (not a restatement).',
    'Output ONLY the insights, one per line, each prefixed with "- ". No preamble.',
  ].join('\n');
}

// Pure: parse insight bullets from LLM output.
export function parseInsights(text) {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => /^[-*]\s+/.test(l))
    .map(l => l.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
}

export function selectTopFacts(brainPath, topN) {
  const dir = join(brainPath);
  const graphPath = join(dir, 'graph.json');
  const nodesDir = join(dir, 'nodes');
  if (!existsSync(graphPath)) return [];
  const graph = readGraph(graphPath);
  const facts = [];
  for (const nodeId of graph.nodes) {
    const p = join(nodesDir, `${nodeId}.md`);
    if (!existsSync(p)) continue;
    const { frontmatter, body } = parseFrontmatter(readFileSync(p, 'utf8'));
    if (frontmatter.type === 'insight') continue; // don't reflect on reflections
    // #144/#155: skip superseded facts — reflecting on stale/contradicted facts would
    // generate insights from information the user has since corrected.
    if (frontmatter.superseded_by) continue;
    const importance = parseFloat(frontmatter.importance ?? 0) || 0;
    facts.push({ text: body.trim().replace(/^[-*]\s*/, '').trim(), importance });
  }
  return facts.sort((a, b) => b.importance - a.importance).slice(0, topN).map(f => f.text);
}

// Non-essential background feature (weekly reflection) -- pinned to the cheapest tier
// so it doesn't silently inherit whatever model `claude -p` defaults to (this machine's
// CLI default is sonnet, per ~/.claude/settings.json -- expensive for a task this simple).
const defaultLlm = (prompt) => execFileSync('claude', ['-p', prompt, '--model', 'claude-haiku-4-5-20251001'], { encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, AGENT_MEMORY_CAPTURE: '1' } });

export function reflect({ topN = 10, dryRun = false, llm = defaultLlm } = {}) {
  const brainPath = join(agentMemoryRoot(), 'nexus', 'personal-brain');
  const facts = selectTopFacts(brainPath, topN);
  if (facts.length === 0) return { ok: false, message: 'no facts to reflect on', insights: [] };

  const prompt = buildReflectionPrompt(facts);
  if (dryRun) return { ok: true, dryRun: true, prompt, insights: [] };

  let raw;
  try { raw = llm(prompt); } catch (e) { return { ok: false, message: `llm failed: ${e.message}`, insights: [] }; }
  const insights = parseInsights(raw);

  const written = [];
  for (const insight of insights) {
    const r = remember({ fact: insight, section: 'Learned Insights' });
    if (r.added) written.push(insight);
  }
  return { ok: true, insights, written };
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  const topN = parseInt((process.argv.find(a => a.startsWith('--top=')) || '--top=10').split('=')[1]);
  const dryRun = process.argv.includes('--dry-run');
  const r = reflect({ topN, dryRun });
  if (!r.ok) { console.error(`memory-reflect: ${r.message}`); process.exit(1); }
  if (dryRun) { console.log(r.prompt); process.exit(0); }
  console.log(`reflect: ${r.insights.length} insights, ${r.written.length} new written`);
  for (const w of r.written) console.log(`  + ${w}`);
}
