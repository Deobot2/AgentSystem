#!/usr/bin/env node
// backfill-salience.js — one-time idempotent pass over personal-brain nodes missing `salience:`.
// Computes salience via computeSalience() from graph-lib.js and writes it into each node's
// YAML frontmatter. Skips nodes already stamped. Safe to re-run.
//
// Usage:
//   node tools/backfill-salience.js [--dry-run] [--brain-path=<path>]

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { computeSalience } from './graph/graph-lib.js';
import { isMainModule } from './is-main.js';

function parseArgs() {
  const flags = { dryRun: false, brainPath: null };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') flags.dryRun = true;
    const m = arg.match(/^--brain-path=(.+)$/);
    if (m) flags.brainPath = m[1].replace(/^~/, homedir());
  }
  return flags;
}

// Extract `importance:` from frontmatter (float, or 0 if absent).
function importanceFromFrontmatter(raw) {
  const m = raw.match(/^importance:\s*([\d.]+)/m);
  return m ? parseFloat(m[1]) : 0;
}

// Stamp salience into the `---` frontmatter block, right after the opening `---\n`.
// Returns the modified content, or null if already stamped (idempotency).
function stampSalience(raw, salience) {
  if (raw.includes('\nsalience:')) return null; // already stamped
  // Insert after the first `---\n` line
  return raw.replace(/^---\n/, `---\nsalience: ${salience}\n`);
}

function main() {
  const { dryRun, brainPath } = parseArgs();
  const nodesDir = join(
    brainPath || join(homedir(), 'agent-memory', 'nexus', 'personal-brain'),
    'nodes'
  );

  if (!existsSync(nodesDir)) {
    console.error(`[backfill-salience] nodes dir not found: ${nodesDir}`);
    process.exit(1);
  }

  const files = readdirSync(nodesDir).filter(f => f.endsWith('.md'));
  let skipped = 0;
  let stamped = 0;
  const sampledNodes = [];

  for (const file of files) {
    const filePath = join(nodesDir, file);
    const raw = readFileSync(filePath, 'utf8');

    if (raw.includes('\nsalience:')) {
      skipped++;
      continue;
    }

    // For backfill we have no ADD/UPDATE signal. Map importance directly to a salience score
    // by treating importance > 0.6 as a "first-time-solve" equivalent and low importance
    // (< 0.3) as uncertain (adds the presolveConfidence bonus). This gives a meaningful
    // spread across nodes without inventing signals we don't have.
    const imp = importanceFromFrontmatter(raw);
    const firstTimeSolve = imp >= 0.6;
    const presolveConfidence = imp < 0.3 ? 0.2 : imp;
    const salience = computeSalience({ firstTimeSolve, presolveConfidence });

    const stamped_raw = stampSalience(raw, salience);
    if (!stamped_raw) { skipped++; continue; }

    if (!dryRun) {
      writeFileSync(filePath, stamped_raw, 'utf8');
    }
    stamped++;
    if (sampledNodes.length < 5) sampledNodes.push({ file, salience, imp });
  }

  console.log(`[backfill-salience] ${dryRun ? '(dry-run) ' : ''}stamped=${stamped} skipped=${skipped} total=${files.length}`);
  if (sampledNodes.length > 0) {
    console.log('[backfill-salience] sample nodes:');
    for (const n of sampledNodes) {
      console.log(`  ${n.file.replace('.md', '')} → salience=${n.salience} (importance=${n.imp})`);
    }
  }
}

if (isMainModule(import.meta.url)) main();
