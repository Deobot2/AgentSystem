#!/usr/bin/env node
// memory-tune.js — closes the learning loop: importance auto-tune from access stats,
// SONA history compaction, and feeding failure patterns into agent-brain as "avoid" facts.
// See issue #123.
//
// Usage:
//   node tools/memory-tune.js --brain=personal-brain [--fix] [--sona] [--avoid-facts]
//
// Modes (any combination; default with no flags is report-only, no writes):
//   --fix           Apply importance tuning (boost accessed nodes, decay stale ones), write back
//   --sona          Compact sona-patterns.md (archive >30d entries, cap live file), write back
//   --routing-log   Cap routing-log.jsonl (#124) by line count/bytes, archive overflow (#117 policy)
//   --avoid-facts   Scan SONA success:no entries, write "avoid" facts into agent-brain
//   --all           Shorthand for --fix --sona --routing-log --avoid-facts

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { agentMemoryRoot, parseFrontmatter, serializeFrontmatter } from './graph/graph-lib.js';
import { parseEntries } from './memory-search.js';
import { isMainModule } from './is-main.js';

const BOOST_PER_ACCESS = 0.03;
const MAX_IMPORTANCE = 1.0;
const DECAY_STEP = 0.02;
const BASELINE_IMPORTANCE = 0.5;
const STALE_DECAY_DAYS = 30; // never accessed in this many days -> eligible for decay
const SONA_MAX_ENTRIES = 200;
const SONA_MAX_BYTES = 40 * 1024;
// #124/#117: routing-log.jsonl gets the same cap-and-archive treatment as sona-patterns.md —
// it's an unbounded append-only log fed by hooks/memory-router.js + hooks/sona-writeback-hook.js
// on every prompt/Stop, so left unmanaged it grows without bound.
const ROUTING_LOG_MAX_LINES = 5000;
const ROUTING_LOG_MAX_BYTES = 2 * 1024 * 1024;
const SONA_ARCHIVE_AGE_DAYS = 30;

// Pure: read visits.log JSONL, return Map<nodeId, {count, lastVisited}>.
export function aggregateVisits(lines) {
  const stats = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec.ts || !Array.isArray(rec.nodes)) continue;
    for (const nodeId of rec.nodes) {
      const cur = stats.get(nodeId) || { count: 0, lastVisited: null };
      cur.count += 1;
      if (!cur.lastVisited || rec.ts > cur.lastVisited) cur.lastVisited = rec.ts;
      stats.set(nodeId, cur);
    }
  }
  return stats;
}

// Pure: given current importance + visit stats for one node, compute the new importance.
// Accessed nodes get boosted (bounded); nodes never accessed in `staleDays` and above
// baseline get nudged down toward baseline. Returns the same value if no change applies.
export function tuneImportance(current, visitStat, now = Date.now(), staleDays = STALE_DECAY_DAYS) {
  const cur = Number.isFinite(current) ? current : 0;
  if (visitStat && visitStat.count > 0) {
    return Math.min(MAX_IMPORTANCE, cur + BOOST_PER_ACCESS * visitStat.count);
  }
  if (cur > BASELINE_IMPORTANCE) {
    const last = visitStat && visitStat.lastVisited ? new Date(visitStat.lastVisited).getTime() : null;
    const staleMs = staleDays * 24 * 60 * 60 * 1000;
    const neverOrStale = !last || (now - last) >= staleMs;
    if (neverOrStale) {
      return Math.max(BASELINE_IMPORTANCE, cur - DECAY_STEP);
    }
  }
  return cur;
}

function applyImportanceTuning(brainDir, quiet) {
  const graphPath = join(brainDir, 'graph.json');
  const visitsPath = join(brainDir, 'visits.log');
  if (!existsSync(graphPath)) {
    if (!quiet) console.log('  [tune] no graph.json, skipping');
    return [];
  }
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  const visitLines = existsSync(visitsPath) ? readFileSync(visitsPath, 'utf8').split('\n') : [];
  const stats = aggregateVisits(visitLines);
  const changes = [];

  for (const nodeId of graph.nodes) {
    const nodePath = join(brainDir, 'nodes', `${nodeId}.md`);
    if (!existsSync(nodePath)) continue;
    const raw = readFileSync(nodePath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(raw);
    const before = parseFloat(frontmatter.importance ?? 0) || 0;
    const after = tuneImportance(before, stats.get(nodeId));
    if (Math.abs(after - before) > 1e-9) {
      frontmatter.importance = Math.round(after * 1000) / 1000;
      writeFileSync(nodePath, serializeFrontmatter(frontmatter, body), 'utf8');
      changes.push({ nodeId, before, after: frontmatter.importance });
    }
  }
  return changes;
}

// Pure: split parsed SONA entries into { keep, archive } by age (30-day cutoff) and
// live-file cap (entry count + byte size). Newest entries are always preferred for keep.
export function planSonaCompaction(entries, now = Date.now(), {
  maxEntries = SONA_MAX_ENTRIES, maxBytes = SONA_MAX_BYTES, archiveAgeDays = SONA_ARCHIVE_AGE_DAYS,
} = {}) {
  const withAge = entries.map(e => {
    const t = Date.parse((e.date || '').trim());
    const ageDays = Number.isFinite(t) ? (now - t) / (24 * 60 * 60 * 1000) : 0;
    return { ...e, ageDays };
  });
  // Old-first for archiving decisions, but keep overall doc order for the final render.
  const eligibleForArchive = withAge.filter(e => e.ageDays >= archiveAgeDays);
  const recent = withAge.filter(e => e.ageDays < archiveAgeDays);

  let keep = recent.slice();
  let archive = eligibleForArchive.slice();

  // If still over cap after archiving all old entries, archive oldest-remaining recents too.
  let bytes = keep.reduce((s, e) => s + Buffer.byteLength(e.raw, 'utf8'), 0);
  const sortedByAgeDesc = keep.slice().sort((a, b) => b.ageDays - a.ageDays);
  let i = 0;
  while ((keep.length > maxEntries || bytes > maxBytes) && i < sortedByAgeDesc.length) {
    const victim = sortedByAgeDesc[i++];
    keep = keep.filter(e => e !== victim);
    archive.push(victim);
    bytes -= Buffer.byteLength(victim.raw, 'utf8');
  }
  return { keep, archive };
}

// Pure: cap JSONL routing-log lines by count and total bytes, oldest-first eviction. Unlike
// SONA entries (which carry a parseable date), routing-log.jsonl is strictly append-only, so
// array order already implies chronological order — no age parsing needed.
export function planRoutingLogCompaction(lines, {
  maxLines = ROUTING_LOG_MAX_LINES, maxBytes = ROUTING_LOG_MAX_BYTES,
} = {}) {
  const nonEmpty = lines.filter(l => l.trim());
  let keep = nonEmpty.slice();
  const archive = [];
  let bytes = keep.reduce((s, l) => s + Buffer.byteLength(l, 'utf8') + 1, 0);
  while ((keep.length > maxLines || bytes > maxBytes) && keep.length > 0) {
    const victim = keep.shift();
    archive.push(victim);
    bytes -= Buffer.byteLength(victim, 'utf8') + 1;
  }
  return { keep, archive };
}

function compactRoutingLog(nexus, quiet) {
  const logPath = join(nexus, 'routing-log.jsonl');
  if (!existsSync(logPath)) {
    if (!quiet) console.log('  [routing-log] no routing-log.jsonl, skipping');
    return { archived: 0, kept: 0 };
  }
  const raw = readFileSync(logPath, 'utf8');
  const lines = raw.split('\n');
  const { keep, archive } = planRoutingLogCompaction(lines);
  if (archive.length === 0) {
    if (!quiet) console.log(`  [routing-log] ${keep.length} entries, under cap — no compaction needed`);
    return { archived: 0, kept: keep.length };
  }

  const archiveDir = join(nexus, 'routing-log-archive');
  mkdirSync(archiveDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const archivePath = join(archiveDir, `routing-log-archive-${stamp}.jsonl`);
  appendFileSync(archivePath, archive.join('\n') + '\n', 'utf8');
  writeFileSync(logPath, keep.length ? keep.join('\n') + '\n' : '', 'utf8');

  if (!quiet) {
    console.log(`  [routing-log] archived ${archive.length}, kept ${keep.length} (${archivePath})`);
  }
  return { archived: archive.length, kept: keep.length };
}

// Pure: cluster archived entries by a coarse task-type key (first two words of the id tag,
// e.g. "[episodic]" -> "episodic") and summarize success rate per cluster.
export function summarizeArchive(archiveEntries) {
  const clusters = new Map();
  for (const e of archiveEntries) {
    const key = (e.id || 'unknown').replace(/[\[\]]/g, '').trim() || 'unknown';
    const cur = clusters.get(key) || { key, total: 0, success: 0 };
    cur.total += 1;
    if (/success:\s*yes/i.test(e.text)) cur.success += 1;
    clusters.set(key, cur);
  }
  return [...clusters.values()].map(c => ({ ...c, successRate: c.total ? c.success / c.total : 0 }));
}

function compactSona(nexus, quiet) {
  const sonaPath = join(nexus, 'sona-patterns.md');
  if (!existsSync(sonaPath)) {
    if (!quiet) console.log('  [sona] no sona-patterns.md, skipping');
    return { archived: 0, kept: 0 };
  }
  const raw = readFileSync(sonaPath, 'utf8');
  const entries = parseEntries(raw);
  if (entries.length === 0) return { archived: 0, kept: 0 };

  const { keep, archive } = planSonaCompaction(entries);
  if (archive.length === 0) {
    if (!quiet) console.log(`  [sona] ${entries.length} entries, under cap — no compaction needed`);
    return { archived: 0, kept: entries.length };
  }

  const archiveDir = join(nexus, 'sona-archive');
  mkdirSync(archiveDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const archivePath = join(archiveDir, `sona-archive-${stamp}.md`);
  const summary = summarizeArchive(archive);
  const summaryLines = summary.map(s => `- ${s.key}: ${s.total} entries, ${(s.successRate * 100).toFixed(0)}% success`);
  const archiveContent = [
    `# SONA Archive — ${stamp}`,
    '',
    '## Summary (by task-type cluster)',
    ...summaryLines,
    '',
    '## Archived entries (raw)',
    '',
    archive.map(e => e.raw.trimEnd()).join('\n\n'),
    '',
  ].join('\n');
  appendFileSync(archivePath, archiveContent, 'utf8');

  const header = raw.split(/^### /m)[0];
  const newContent = header + keep.map(e => e.raw.trimEnd()).join('\n\n') + '\n';
  writeFileSync(sonaPath, newContent, 'utf8');

  if (!quiet) {
    console.log(`  [sona] archived ${archive.length}, kept ${keep.length} (${archivePath})`);
  }
  return { archived: archive.length, kept: keep.length };
}

// Pure: given parsed SONA entries, return one "avoid" fact per (agent, failure summary) where
// the entry's **A:** line marks success: no. Best-effort text extraction, no LLM call.
export function extractAvoidFacts(entries) {
  const facts = [];
  for (const e of entries) {
    if (!/success:\s*no/i.test(e.text)) continue;
    const agent = (e.agent || '').trim();
    if (!agent) continue;
    const aLine = e.text.split('\n').find(l => l.trim().startsWith('**A:**'));
    const summary = aLine ? aLine.replace(/\*\*A:\*\*/, '').replace(/\|\s*success:.*/i, '').trim() : 'approach failed (see archived SONA entry)';
    facts.push({ agent, fact: `Avoid: ${summary}` });
  }
  return facts;
}

function writeAvoidFacts(nexus, facts, quiet) {
  let written = 0;
  for (const { agent, fact } of facts) {
    const dir = join(nexus, 'agent-brain', agent.toLowerCase(), 'nodes');
    if (!existsSync(join(nexus, 'agent-brain', agent.toLowerCase()))) continue; // unknown agent, skip
    mkdirSync(dir, { recursive: true });
    const id = `avoid-${Buffer.from(fact).toString('hex').slice(0, 16)}`;
    const p = join(dir, `${id}.md`);
    if (existsSync(p)) continue; // dedup
    const frontmatter = {
      id, type: 'avoid-fact', brain: `agent-brain/${agent.toLowerCase()}`,
      created: new Date().toISOString().slice(0, 10), agent: agent.toLowerCase(),
      relevance_keywords: [agent.toLowerCase(), 'avoid'], importance: 0.6, hot: false,
    };
    writeFileSync(p, serializeFrontmatter(frontmatter, fact), 'utf8');
    written++;
  }
  if (!quiet) console.log(`  [avoid-facts] wrote ${written} new avoid fact(s)`);
  return written;
}

function parseArgs(argv) {
  const flags = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    if (m) flags[m[1]] = m[2] ?? true;
  }
  return flags;
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  const flags = parseArgs(process.argv);
  const quiet = !!flags.quiet;
  const brain = flags.brain || 'personal-brain';
  const nexus = join(agentMemoryRoot(), 'nexus');
  const brainDir = join(nexus, brain);
  const doAll = !!flags.all;

  if (!quiet) console.log(`memory-tune [${brain}]:`);

  if (doAll || flags.fix) {
    const changes = applyImportanceTuning(brainDir, quiet);
    if (changes.length > 0) {
      if (!quiet) {
        console.log(`  [tune] ${changes.length} node(s) re-tuned:`);
        for (const c of changes) console.log(`    ${c.nodeId}: ${c.before} -> ${c.after}`);
      }
    } else if (!quiet) {
      console.log('  [tune] no changes');
    }
  }

  if (doAll || flags.sona) {
    compactSona(nexus, quiet);
  }

  if (doAll || flags['routing-log']) {
    compactRoutingLog(nexus, quiet);
  }

  if (doAll || flags['avoid-facts']) {
    const sonaPath = join(nexus, 'sona-patterns.md');
    const entries = existsSync(sonaPath) ? parseEntries(readFileSync(sonaPath, 'utf8')) : [];
    const facts = extractAvoidFacts(entries);
    writeAvoidFacts(nexus, facts, quiet);
  }

  if (!doAll && !flags.fix && !flags.sona && !flags['routing-log'] && !flags['avoid-facts']) {
    if (!quiet) console.log('  (report-only run — pass --fix, --sona, --avoid-facts, or --all to apply changes)');
  }
}
