#!/usr/bin/env node
// sam-audit-cache.js — reuse Sam's prior verdict when a PR's diff has not changed (#337).
//
// sam-audit.yml re-runs a full Claude audit on every `synchronize`, including a re-push whose
// merge-base diff is byte-identical to one already audited (a rebase, a force-push that reorders
// commits without changing content, a CI-triggered re-run). That is a full model session for zero
// new content to review.
//
// This tool is deliberately narrow and fails toward auditing:
//   - Reuse only ever applies to a prior APPROVED verdict. `blocked` and `error` are never cached
//     as reusable — a blocked PR must be re-audited once the author claims to have fixed it, and
//     an error means no verdict was ever established.
//   - Keyed on (PR number, base ref, diff hash) — never the commit SHA, since the SHA changes on
//     every push even when the diff content does not. Any change to the base ref invalidates the
//     cache entry outright, so a retarget never reuses a verdict computed against a different base.
//   - Any read/parse/hash failure is treated as a cache MISS, never a hit. A tool that fails toward
//     "skip the audit" on its own error would be exactly the #316/#326 failure mode this exists to
//     avoid repeating; a tool that fails toward "run the audit" only ever costs a redundant session.
//
// Cache location: `cacheDir()/sam-audit-cache/pr-<n>.json` on the self-hosted runner's host — the
// same runner executes every audit for this repo, so this is durable per-PR state without needing
// a database or a GitHub API round-trip. Not committed, not shared across hosts; a cache miss on a
// different or freshly-provisioned runner just costs one redundant audit, never a wrong verdict.
//
// Usage:
//   node tools/sam-audit-cache.js check  --pr <n> --base-ref <ref> --diff-file <path> [--cache-dir <dir>]
//   node tools/sam-audit-cache.js record --pr <n> --base-ref <ref> --diff-file <path> --run-id <id> [--cache-dir <dir>]
//
// Both print one JSON line to stdout and exit 0 on success. `check` never throws for a missing or
// corrupt cache file — that is a normal miss. Exit 2 is reserved for bad usage (missing required
// flags), which the workflow should treat the same as a miss (fail toward auditing).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isMainModule } from './is-main.js';
import { cacheDir as sharedCacheDir } from './brain-sync-run.js';

export function cacheDir() {
  return join(sharedCacheDir(), 'sam-audit-cache');
}

function cacheFile(dir, pr) {
  return join(dir, `pr-${pr}.json`);
}

/** sha256 of a file's contents. Throws on a missing/unreadable file — callers must catch. */
export function hashDiffFile(path) {
  const contents = readFileSync(path);
  return createHash('sha256').update(contents).digest('hex');
}

/** Returns the parsed cache entry for `pr`, or null on any missing/corrupt cache (never throws). */
export function readEntry(dir, pr) {
  try {
    const raw = readFileSync(cacheFile(dir, pr), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Decide whether a prior verdict may be reused.
 * @returns {{reuse: boolean, reason: string, cachedAt?: string, runId?: string}}
 */
export function check({ pr, baseRef, diffFile, dir = cacheDir() }) {
  if (!pr || !baseRef || !diffFile) {
    return { reuse: false, reason: 'missing required input (pr/baseRef/diffFile)' };
  }
  let diffHash;
  try {
    diffHash = hashDiffFile(diffFile);
  } catch (err) {
    return { reuse: false, reason: `could not hash diff: ${err.message}` };
  }
  const entry = readEntry(dir, pr);
  if (!entry) return { reuse: false, reason: 'no cache entry for this PR' };
  if (entry.verdict !== 'approved') {
    return { reuse: false, reason: `cached verdict was '${entry.verdict}', not 'approved'` };
  }
  if (entry.baseRef !== baseRef) {
    return { reuse: false, reason: `base ref changed (cached '${entry.baseRef}' vs current '${baseRef}')` };
  }
  if (entry.diffHash !== diffHash) {
    return { reuse: false, reason: 'diff changed since the cached audit' };
  }
  return {
    reuse: true,
    reason: `diff unchanged since the audit on run ${entry.runId} (${entry.auditedAt})`,
    cachedAt: entry.auditedAt,
    runId: entry.runId,
  };
}

/** Records a fresh APPROVED verdict for `pr`. Never throws on a write failure — logs and returns null. */
export function record({ pr, baseRef, diffFile, runId, dir = cacheDir() }) {
  if (!pr || !baseRef || !diffFile || !runId) {
    throw new Error('record requires pr, baseRef, diffFile, and runId');
  }
  const diffHash = hashDiffFile(diffFile);
  const entry = {
    verdict: 'approved',
    baseRef,
    diffHash,
    runId: String(runId),
    auditedAt: new Date().toISOString(),
  };
  const file = cacheFile(dir, pr);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(entry, null, 2));
  return entry;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const name = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
      out[name] = val;
      if (val !== true) i += 1;
    }
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const dir = args['cache-dir'] || cacheDir();

  if (cmd === 'check') {
    const result = check({ pr: args.pr, baseRef: args['base-ref'], diffFile: args['diff-file'], dir });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
    return;
  }

  if (cmd === 'record') {
    if (!args.pr || !args['base-ref'] || !args['diff-file'] || !args['run-id']) {
      process.stderr.write('record requires --pr --base-ref --diff-file --run-id\n');
      process.exit(2);
      return;
    }
    try {
      const entry = record({
        pr: args.pr,
        baseRef: args['base-ref'],
        diffFile: args['diff-file'],
        runId: args['run-id'],
        dir,
      });
      process.stdout.write(JSON.stringify({ recorded: true, ...entry }) + '\n');
      process.exit(0);
    } catch (err) {
      // Recording is best-effort: a write failure should not fail the workflow step that already
      // has a real approved verdict in hand. Report it, don't throw.
      process.stdout.write(JSON.stringify({ recorded: false, error: err.message }) + '\n');
      process.exit(0);
    }
    return;
  }

  process.stderr.write('usage: sam-audit-cache.js <check|record> --pr <n> --base-ref <ref> --diff-file <path> [--run-id <id>] [--cache-dir <dir>]\n');
  process.exit(2);
}

if (isMainModule(import.meta.url)) main();
