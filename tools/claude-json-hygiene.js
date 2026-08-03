#!/usr/bin/env node
// claude-json-hygiene.js — prune stale .claude.json corruption/backup files and orphaned
// *.tmp.* files under ~/.claude (#118). Local machine state, not repo-tracked, same
// architectural pattern as tools/caveman-cache-fix.js for #116.
//
// Handles the three symptoms from #118:
//   1. .claude.json.corrupted.* / .claude.json.backup.* churn — keep only the most recent N
//      (default 5) of each family, sorted by mtime; delete the rest.
//   2. Orphaned *.tmp.* files (installed_plugins.json.tmp.*, known_marketplaces.json.tmp.*,
//      .credentials.json.tmp.*, etc.) older than --tmp-age-hours (default 24) — these are
//      leftovers from a writer that crashed/was killed before an atomic rename completed.
//   3. Reports (does not fix) concurrent-writer correlation: if 2+ corrupted/backup files
//      share the same minute-resolution timestamp, flags it as a likely concurrent-write
//      collision for the operator to investigate further (session log cross-reference is a
//      manual follow-up — this tool only surfaces the signal).
//
// Usage:
//   node tools/claude-json-hygiene.js [--home=PATH] [--keep=5] [--tmp-age-hours=24] [--dry-run]
//
// No npm deps (project convention for tools/**).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isMainModule } from './is-main.js';

function parseArgs(argv) {
  const flags = { home: os.homedir(), keep: 5, tmpAgeHours: 24, dryRun: false };
  for (const a of argv) {
    if (a === '--dry-run') flags.dryRun = true;
    else if (a.startsWith('--home=')) flags.home = a.slice('--home='.length);
    else if (a.startsWith('--keep=')) flags.keep = parseInt(a.slice('--keep='.length), 10);
    else if (a.startsWith('--tmp-age-hours=')) flags.tmpAgeHours = parseFloat(a.slice('--tmp-age-hours='.length));
  }
  return flags;
}

// Find files directly under `dir` whose basename matches `.claude.json.corrupted.*` or
// `.claude.json.backup.*`. Non-recursive by design — only ~/.claude.json siblings matter.
function findClaudeJsonBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && /^\.claude\.json\.(corrupted|backup)\./.test(e.name))
    .map(e => {
      const full = path.join(dir, e.name);
      const family = e.name.match(/^\.claude\.json\.(corrupted|backup)\./)[1];
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
      return { full, name: e.name, family, mtimeMs };
    });
}

// Prune all but the newest `keep` files per family. Returns { deleted, keptCollisions }.
function pruneBackups(files, keep, dryRun) {
  const byFamily = {};
  for (const f of files) {
    (byFamily[f.family] ||= []).push(f);
  }
  const deleted = [];
  const collisions = [];
  for (const family of Object.keys(byFamily)) {
    const sorted = byFamily[family].slice().sort((a, b) => b.mtimeMs - a.mtimeMs);
    const toDelete = sorted.slice(keep);
    for (const f of toDelete) {
      deleted.push(f.full);
      if (!dryRun) { try { fs.unlinkSync(f.full); } catch { /* ignore */ } }
    }
    // Flag same-minute clusters among the KEPT files as a likely concurrent-writer signal.
    const kept = sorted.slice(0, keep);
    const byMinute = {};
    for (const f of kept) {
      const minuteKey = Math.floor(f.mtimeMs / 60000);
      (byMinute[minuteKey] ||= []).push(f.name);
    }
    for (const names of Object.values(byMinute)) {
      if (names.length > 1) collisions.push({ family, names });
    }
  }
  return { deleted, collisions };
}

// Find orphaned *.tmp.* files (anywhere under a shallow walk of plugins/ and top-level dir)
// older than ageHours. These are atomic-write leftovers from a writer that never renamed.
function findOrphanedTmpFiles(homeDir, ageHours) {
  const cutoff = Date.now() - ageHours * 3600 * 1000;
  const searchDirs = [
    homeDir,
    path.join(homeDir, '.claude'),
    path.join(homeDir, '.claude', 'plugins'),
  ];
  const found = [];
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !/\.tmp\.[a-zA-Z0-9]+$/.test(e.name)) continue;
      const full = path.join(dir, e.name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.mtimeMs < cutoff) found.push(full);
    }
  }
  return found;
}

function deleteFiles(files, dryRun) {
  const deleted = [];
  for (const f of files) {
    deleted.push(f);
    if (!dryRun) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  }
  return deleted;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const homeDir = path.resolve(flags.home);
  const claudeDir = path.join(homeDir, '.claude');

  console.log(`[claude-json-hygiene] home=${homeDir} keep=${flags.keep} tmp-age-hours=${flags.tmpAgeHours} dry-run=${flags.dryRun}`);

  const backups = findClaudeJsonBackups(homeDir);
  const { deleted: deletedBackups, collisions } = pruneBackups(backups, flags.keep, flags.dryRun);
  console.log(`[claude-json-hygiene] ${backups.length} .claude.json backup/corrupted files found, ${deletedBackups.length} ${flags.dryRun ? 'would be' : ''} pruned (keeping ${flags.keep} newest per family)`);
  for (const f of deletedBackups) console.log(`  ${flags.dryRun ? '[dry-run] would delete' : 'deleted'}: ${f}`);
  if (collisions.length > 0) {
    console.log(`[claude-json-hygiene] WARNING: ${collisions.length} same-minute file cluster(s) among kept backups — signals possible concurrent writers to .claude.json:`);
    for (const c of collisions) console.log(`  [${c.family}] ${c.names.join(', ')}`);
  }

  const tmpFiles = findOrphanedTmpFiles(homeDir, flags.tmpAgeHours);
  const deletedTmp = deleteFiles(tmpFiles, flags.dryRun);
  console.log(`[claude-json-hygiene] ${tmpFiles.length} orphaned *.tmp.* file(s) older than ${flags.tmpAgeHours}h found, ${deletedTmp.length} ${flags.dryRun ? 'would be' : ''} deleted`);
  for (const f of deletedTmp) console.log(`  ${flags.dryRun ? '[dry-run] would delete' : 'deleted'}: ${f}`);
}

export { findClaudeJsonBackups, pruneBackups, findOrphanedTmpFiles, deleteFiles };

const isMain = isMainModule(import.meta.url);
if (isMain) main();
