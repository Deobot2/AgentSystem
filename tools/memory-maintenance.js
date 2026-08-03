#!/usr/bin/env node
// memory-maintenance.js — the "sleep cycle". Runs the full memory maintenance pass.
// Wired two ways: (1) SessionStart hook with --if-stale (run-on-use), (2) scheduled cron.
// Steps: split → reconsolidate → decay → stale-prune → consolidate → agent-brain-seed.
// Reflection (LLM, slow) only with --reflect. Each step is non-fatal; failures are logged.
// Usage: node tools/memory-maintenance.js [--if-stale=DAYS] [--reflect] [--dry-run] [--quiet] [--help]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { agentMemoryRoot } from './graph/graph-lib.js';
import { parseFlagsOrExit } from './cli-args.js';
import { isMainModule } from './is-main.js';

const USAGE = 'Usage: node tools/memory-maintenance.js [--if-stale=DAYS] [--reflect] [--dry-run] [--quiet] [--help]';

// Pure: should maintenance run? True if never run, or last run older than `days`.
export function isStale(lastRunIso, days, now = Date.now()) {
  if (!days || days <= 0) return true;
  if (!lastRunIso) return true;
  const last = new Date(lastRunIso).getTime();
  if (!Number.isFinite(last)) return true;
  return (now - last) >= days * 24 * 60 * 60 * 1000;
}

const toolsDir = dirname(fileURLToPath(import.meta.url));
const nexus = join(agentMemoryRoot(), 'nexus');
const pbPath = join(nexus, 'personal-brain');

function step(name, file, args, quiet) {
  try {
    const out = execFileSync('node', [join(toolsDir, file), ...args], { encoding: 'utf8', timeout: 180000 });
    if (!quiet) console.log(`  ✓ ${name}`);
    return { name, ok: true, out };
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message.split('\n')[0]}`);
    return { name, ok: false };
  }
}

export function runMaintenance({ reflect = false, quiet = false } = {}) {
  const results = [];
  results.push(step('split', 'personal-brain-split.js', [], quiet));
  results.push(step('reconsolidate', 'memory-reconsolidate.js', [`--brain-path=${pbPath}`], quiet));
  results.push(step('decay', 'memory-decay.js', ['--brain=personal-brain'], quiet));
  results.push(step('stale-prune', 'memory-stale.js', ['--brain=personal-brain', '--fix'], quiet));
  results.push(step('memory-tune', 'memory-tune.js', ['--brain=personal-brain', '--all', '--quiet'], quiet));
  results.push(step('consolidate', 'graph/graph-consolidate.js', ['personal-brain', `--brain-path=${pbPath}`], quiet));
  results.push(step('wikilink-sync', 'graph/wikilink-sync.js', [`--brain-path=${pbPath}`], quiet));
  results.push(step('agent-brain-seed', 'agent-brain-seed.js', ['--all'], quiet));
  if (reflect) results.push(step('reflect', 'memory-reflect.js', [], quiet));
  // TIER-2 BLOCKER — cross-project promotion (issue: missing project attribution in SONA)
  // SONA entry headers carry only: id, date, agent (e.g. "studio-harvest-4pr — 2026-05-29 — Friday").
  // parseEntries() in memory-search.js extracts exactly these three fields — no project field.
  // The **N:** (files touched) line exists in the entry body but inferring project from file paths
  // is weak heuristic evidence; the task requires high precision and forbids promoting on weak evidence.
  // Unblock requires: (1) add a `project: <slug>` field to the SONA template in CLAUDE.md/friday.md,
  // (2) extend parseEntries() to capture it, (3) then a promotion step can group by project slug and
  // promote entries confirmed in >=2 distinct project slugs into personal-brain "Cross-Project Patterns".
  return results;
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  const flags = parseFlagsOrExit(process.argv.slice(2), {
    usage: USAGE,
    allowed: ['if-stale', 'reflect', 'dry-run', 'quiet'],
  });
  const quiet = !!flags.quiet;
  const dryRun = !!flags['dry-run'];
  const stampPath = join(nexus, '.last-maintenance');
  const lastRun = existsSync(stampPath) ? readFileSync(stampPath, 'utf8').trim() : null;
  const days = flags['if-stale'] ? parseFloat(flags['if-stale']) : 0;

  if (days && !isStale(lastRun, days)) {
    if (!quiet) console.log(`memory-maintenance: skipped (last run ${lastRun}, < ${days}d ago)`);
    process.exit(0);
  }

  if (dryRun) {
    console.log('[dry-run] would run steps: split, reconsolidate, decay, stale-prune, memory-tune, consolidate, wikilink-sync, agent-brain-seed' + (flags.reflect ? ', reflect' : ''));
    process.exit(0);
  }

  // Claim the run BEFORE working: stamp first so a second session started close behind
  // sees not-stale and skips, avoiding concurrent whole-file writeGraph on live brain data.
  writeFileSync(stampPath, new Date().toISOString(), 'utf8');
  if (!quiet) console.log('memory-maintenance: running sleep cycle');
  const results = runMaintenance({ reflect: !!flags.reflect, quiet });
  const okCount = results.filter(r => r.ok).length;
  if (!quiet) console.log(`memory-maintenance: ${okCount}/${results.length} steps ok`);
}
