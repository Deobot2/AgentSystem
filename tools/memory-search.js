#!/usr/bin/env node
/**
 * memory-search.js — semantic SONA pattern retrieval
 *
 * Primary path: TF-IDF cosine similarity (pure JS, no deps)
 * Optional path: Voyage AI embeddings if VOYAGE_API_KEY is set
 *
 * Usage:
 *   node ~/dev/AgentSystem/tools/memory-search.js --query="auth bug fix" [--top=5]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { isMainModule } from './is-main.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.length ? v.join('=') : true];
    })
);

const query    = args.query || '';
const top      = parseInt(args.top || '5', 10);
const nexusDir = join(homedir(), 'agent-memory', 'nexus');
const sonaFile = join(nexusDir, 'sona-patterns.md');
const cacheFile = join(nexusDir, 'sona-embeddings.json');

// Only run main execution when invoked directly, not when imported by tests
const isMain = isMainModule(import.meta.url);

if (isMain && !query) {
  process.stderr.write('Usage: memory-search.js --query="<text>" [--top=5]\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Entry parsing
// ---------------------------------------------------------------------------
export function parseEntries(markdown) {
  const entries = [];
  const sections = markdown.split(/^### /m).slice(1);
  for (const section of sections) {
    const lines = section.split('\n');
    const header = lines[0].trim();
    const body = lines.slice(1).join('\n').trim();
    const parts = header.split('—').map(s => s.trim());
    entries.push({
      id: parts[0] || header,
      date: parts[1] || '',
      agent: parts[2] || '',
      text: header + ' ' + body,
      raw: '### ' + section,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// TF-IDF helpers (primary path — no API key required)
// ---------------------------------------------------------------------------
export function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

export function buildTfVector(tokens) {
  const freq = {};
  for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
  const total = tokens.length || 1;
  const vec = {};
  for (const [t, c] of Object.entries(freq)) vec[t] = c / total;
  return vec;
}

export function cosineSimilarity(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0, magA = 0, magB = 0;
  for (const k of keys) {
    const av = a[k] || 0;
    const bv = b[k] || 0;
    dot  += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export function tfidfEmbedding(text) {
  return buildTfVector(tokenize(text));
}

// ---------------------------------------------------------------------------
// Dense cosine similarity (Voyage float arrays)
// ---------------------------------------------------------------------------
function denseCosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Voyage AI embeddings (optional)
// ---------------------------------------------------------------------------
function voyageEmbed(texts) {
  return new Promise((resolve, reject) => {
    const key = process.env.VOYAGE_API_KEY;
    if (!key) return reject(new Error('No VOYAGE_API_KEY'));

    const body = JSON.stringify({ model: 'voyage-2', input: texts });
    const options = {
      hostname: 'api.voyageai.com',
      path: '/v1/embeddings',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = httpsRequest(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message || 'Voyage error'));
          resolve(parsed.data.map(d => d.embedding));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------
function loadCache() {
  try { return JSON.parse(readFileSync(cacheFile, 'utf8')); }
  catch { return {}; }
}

function saveCache(cache) {
  mkdirSync(nexusDir, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
}

// ---------------------------------------------------------------------------
// TF-IDF search (always available)
// ---------------------------------------------------------------------------
function tfidfSearch(entries) {
  const queryVec = tfidfEmbedding(query);
  const results = entries.map(e => ({
    entry: e.id,
    date: e.date,
    agent: e.agent,
    score: cosineSimilarity(queryVec, tfidfEmbedding(e.text)),
    summary: e.text.slice(0, 200),
  }));
  results.sort((a, b) => b.score - a.score);
  process.stdout.write(JSON.stringify(results.slice(0, top), null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!existsSync(sonaFile)) {
    process.stdout.write(JSON.stringify([]));
    return;
  }

  const md = readFileSync(sonaFile, 'utf8');
  const entries = parseEntries(md);

  if (entries.length === 0) {
    process.stdout.write(JSON.stringify([]));
    return;
  }

  if (!process.env.VOYAGE_API_KEY) {
    tfidfSearch(entries);
    return;
  }

  // Voyage path
  const cache = loadCache();
  const missing = entries.filter(e => !cache[e.id] || !Array.isArray(cache[e.id]));
  if (missing.length > 0) {
    try {
      const embeddings = await voyageEmbed(missing.map(e => e.text));
      for (let i = 0; i < missing.length; i++) {
        cache[missing[i].id] = embeddings[i];
      }
      saveCache(cache);
    } catch (err) {
      process.stderr.write(`Voyage API unavailable (${err.message}), falling back to TF-IDF\n`);
      tfidfSearch(entries);
      return;
    }
  }

  let queryVec;
  try {
    [queryVec] = await voyageEmbed([query]);
  } catch (err) {
    process.stderr.write(`Voyage embed query failed (${err.message}), falling back to TF-IDF\n`);
    tfidfSearch(entries);
    return;
  }

  const results = entries.map(e => ({
    entry: e.id,
    date: e.date,
    agent: e.agent,
    score: denseCosineSimilarity(queryVec, cache[e.id] || []),
    summary: e.text.slice(0, 200),
  }));
  results.sort((a, b) => b.score - a.score);
  process.stdout.write(JSON.stringify(results.slice(0, top), null, 2));
}

if (isMain) {
  main().catch(err => {
    process.stderr.write(`memory-search error: ${err.message}\n`);
    process.exit(1);
  });
}
