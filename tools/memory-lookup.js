#!/usr/bin/env node
// memory-lookup.js — fuzzy per-agent memory file retrieval (Fix 6, issue #37)
// Replaces brittle grep-exact keyword matching with scored fuzzy recall.
//
// Usage: node tools/memory-lookup.js <agent-name> <keywords...> [--top=N] [--all]
//        [--memory-root=PATH]
//
// Problem with old approach: relevance_keywords: [auth, jwt, token]
// Task mentions "bearer credential refresh" → zero overlap → memory not loaded.
//
// This tool:
//   1. Normalizes keywords (lowercase, strip punctuation, split compounds)
//   2. Expands with a synonym map (auth↔credential, jwt↔token, etc.)
//   3. Scores each memory file: keyword match + body keyword frequency
//   4. Returns top N files sorted by score
//
// Outputs file paths — agents read the returned files.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { agentMemoryRoot } from './graph/graph-lib.js';

// Synonym groups — any word in a group matches any other word in the group.
// Add domain-specific synonyms here as the system grows.
const SYNONYM_GROUPS = [
  ['auth', 'authentication', 'credential', 'credentials', 'bearer', 'login', 'signin', 'sso', 'oidc', 'oauth'],
  ['jwt', 'token', 'access_token', 'refresh_token', 'session', 'cookie'],
  ['error', 'exception', 'failure', 'fail', 'bug', 'issue', 'problem', 'incident'],
  ['retry', 'backoff', 'resilience', 'circuit', 'breaker', 'timeout'],
  ['deploy', 'deployment', 'release', 'ship', 'ci', 'cd', 'pipeline'],
  ['test', 'spec', 'assert', 'verify', 'validate', 'unit', 'integration', 'e2e'],
  ['database', 'db', 'sql', 'query', 'schema', 'migration', 'postgres', 'mysql', 'mongo'],
  ['security', 'vulnerability', 'cve', 'audit', 'pentest', 'xss', 'injection', 'csrf'],
  ['performance', 'latency', 'throughput', 'slow', 'bottleneck', 'optimize', 'cache'],
  ['api', 'endpoint', 'route', 'rest', 'graphql', 'rpc', 'webhook', 'request', 'response'],
  ['memory', 'heap', 'leak', 'oom', 'allocation', 'gc'],
  ['merge', 'pr', 'pull-request', 'review', 'branch', 'commit', 'git'],
];

// Build reverse lookup: word → set of synonyms
function buildSynonymMap(groups) {
  const map = new Map();
  for (const group of groups) {
    const groupSet = new Set(group);
    for (const word of group) {
      map.set(word, groupSet);
    }
  }
  return map;
}
const synonymMap = buildSynonymMap(SYNONYM_GROUPS);

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[_\-\/\.]/g, ' ') // split compound-words
    .replace(/[^a-z0-9 ]/g, '')
    .split(/\s+/)
    .filter(Boolean);
}

function expandKeywords(keywords) {
  const expanded = new Set(keywords);
  for (const kw of keywords) {
    const synonyms = synonymMap.get(kw);
    if (synonyms) {
      for (const s of synonyms) expanded.add(s);
    }
  }
  return [...expanded];
}

function parseFrontmatterKeywords(content) {
  const match = content.match(/^---\n([\s\S]*?)\n?---/);
  if (!match) return [];
  const lines = match[1].split('\n');
  for (const line of lines) {
    const m = line.match(/^relevance_keywords:\s+\[([^\]]*)\]/);
    if (m) return m[1].split(',').map(s => s.trim().toLowerCase());
  }
  return [];
}

function scoreFile(content, expandedKeywords) {
  const keywords = parseFrontmatterKeywords(content);
  const bodyWords = normalize(content.replace(/^---[\s\S]*?---/, ''));

  let score = 0;
  for (const kw of expandedKeywords) {
    // Frontmatter keyword match — high weight
    if (keywords.includes(kw)) score += 3;
    // Body frequency — count occurrences, cap at 5
    const freq = Math.min(5, bodyWords.filter(w => w === kw).length);
    score += freq * 0.5;
  }
  // Normalize by number of expanded keywords so score is comparable across queries
  return expandedKeywords.length > 0 ? score / expandedKeywords.length : 0;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of args) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v ?? true;
  } else {
    positional.push(a);
  }
}

const [agentName, ...rawKeywords] = positional;
if (!agentName) {
  console.error('Usage: memory-lookup.js <agent-name> <keywords...> [--top=N] [--all]');
  process.exit(1);
}

const topN = parseInt(flags.top || '5');
const showAll = !!flags.all;
const jsonOut = !!flags.json;
// Per-agent memory nodes live at <root>/nexus/agent-brain/<agent>/nodes — the same
// place brain-remember.js writes them. This used to default to <root>/<agent>,
// which has never existed, so every default-path lookup found nothing. It went
// unnoticed because every test passes --memory-root explicitly.
const memoryRoot = flags['memory-root']
  ? resolve(flags['memory-root'])
  : join(agentMemoryRoot(), 'nexus', 'agent-brain', agentName, 'nodes');

// In --json mode "nothing to report" is an empty result, not an error. Callers
// parse stdout (Mission Control's /memory/search does), so prose here or a
// non-zero exit turns an empty search into a 500.
if (!existsSync(memoryRoot)) {
  if (jsonOut) { console.log('[]'); process.exit(0); }
  console.error(`No memory directory for agent "${agentName}" at ${memoryRoot}`);
  process.exit(1);
}

const keywords = normalize(rawKeywords.join(' '));
const expanded = expandKeywords(keywords);

// Scan all .md files except MEMORY.md (the index)
const files = readdirSync(memoryRoot)
  .filter(f => f.endsWith('.md') && f !== 'MEMORY.md');

const scored = files.map(f => {
  const path = join(memoryRoot, f);
  const content = readFileSync(path, 'utf8');
  const score = keywords.length > 0 ? scoreFile(content, expanded) : 1.0;
  return { file: f, path, score };
}).filter(r => showAll || r.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, topN);

if (scored.length === 0) {
  console.log(jsonOut ? '[]' : `No memory files matched for "${rawKeywords.join(' ')}" (agent: ${agentName})`);
  process.exit(0);
}

// Output: one path per line (for agent to read), plus scores if verbose
if (jsonOut) {
  console.log(JSON.stringify(scored, null, 2));
} else {
  const expandedNote = expanded.length > keywords.length
    ? ` [+${expanded.length - keywords.length} synonyms expanded]`
    : '';
  console.log(`Top ${scored.length} memory file(s) for "${rawKeywords.join(' ')}"${expandedNote}:\n`);
  for (const r of scored) {
    console.log(`  ${r.path}  (score=${r.score.toFixed(2)})`);
  }
}
