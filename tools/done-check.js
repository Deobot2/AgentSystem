// done-check.js — mechanical verification of an agent's DONE claim.
//
// Agents end runs with a first line of DONE:/BLOCKED:/NEEDS_INPUT: (output protocol).
// Nothing previously checked that a DONE was TRUE — an agent could claim "DONE: merged
// PR #12" with nothing landed, and trust scores would count it a success. This tool
// extracts verifiable claims from the result text and checks them against reality:
//
//   - "merged PR #N" / "PR #N ... merged"  → gh pr view N --json state  (must be MERGED)
//   - commit SHAs (7-40 hex)               → git merge-base --is-ancestor <sha> origin/main
//   - created/added file paths             → fs.existsSync relative to repo root
//
// Verdict:
//   contradicted — DONE claimed, but at least one extracted claim is provably false
//   verified     — DONE claimed, no contradictions, at least one claim checked out
//   unverified   — DONE claimed, but nothing mechanically checkable was found
//   n/a          — result was not a DONE (BLOCKED/NEEDS_INPUT/unknown)
//
// The verdict is written back into the run-log JSON as a `verification` object so
// compute-trust-scores.js can count a contradicted DONE as a failure, not a success.
//
// Usage:
//   node tools/done-check.js <run-log.json> [...more]   verify + annotate specific logs
//   node tools/done-check.js --all                      verify every unannotated log
//
// No npm deps — Node builtins only (tools/ rule). ESM.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main.js';

const RUN_LOG_DIR = path.join(os.homedir(), 'agent-memory', 'nexus', 'run-log');
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ── claim extraction ─────────────────────────────────────────────────────────

// Extract mechanically checkable claims from a DONE result text.
// Returns [{ kind: 'pr-merged'|'commit-landed'|'file-exists', value }].
export function extractClaims(text) {
  if (!text || typeof text !== 'string') return [];
  const claims = [];
  const seen = new Set();
  const add = (kind, value) => {
    const key = `${kind}:${value}`;
    if (!seen.has(key)) { seen.add(key); claims.push({ kind, value }); }
  };

  // PR merge claims: "merged PR #12", "PR #12 merged", "PR #12 ... squash-merged"
  for (const m of text.matchAll(/\bmerged?\b[^.\n]{0,60}?\bPR\s*#(\d+)|\bPR\s*#(\d+)[^.\n]{0,60}?\bmerged\b/gi)) {
    add('pr-merged', m[1] || m[2]);
  }

  // Commit SHA claims: "commit abc1234", "landed as abc1234def"
  for (const m of text.matchAll(/\bcommit\s+([0-9a-f]{7,40})\b|\blanded\b[^.\n]{0,40}?\b([0-9a-f]{7,40})\b/gi)) {
    add('commit-landed', (m[1] || m[2]).toLowerCase());
  }

  // File creation claims: "created tools/foo.js", "added path/to/bar.md"
  for (const m of text.matchAll(/\b(?:created|added|wrote)\s+`?((?:[\w.-]+\/)+[\w.-]+\.\w+)`?/gi)) {
    add('file-exists', m[1]);
  }

  return claims;
}

// ── claim verification ───────────────────────────────────────────────────────

// Default checkers hit gh/git/fs; tests inject fakes.
export const DEFAULT_CHECKERS = {
  'pr-merged': (num) => {
    const out = execFileSync('gh', ['pr', 'view', String(num), '--json', 'state', '-q', '.state'],
      { encoding: 'utf8', cwd: REPO_ROOT, timeout: 30_000 }).trim();
    return out === 'MERGED';
  },
  'commit-landed': (sha) => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'],
        { cwd: REPO_ROOT, timeout: 15_000 });
      return true;
    } catch { return false; }
  },
  'file-exists': (p) => fs.existsSync(path.resolve(REPO_ROOT, p)),
};

// Verify a run-log entry ({ result, ... }). Returns the verification object.
export function verifyRun(entry, checkers = DEFAULT_CHECKERS, now = new Date().toISOString()) {
  const result = entry && typeof entry.result === 'string' ? entry.result : '';
  const firstLine = result.split('\n').map(l => l.trim()).find(l => l !== '') || '';
  if (!/^DONE:/i.test(firstLine)) {
    return { verdict: 'n/a', checkedAt: now, claims: [] };
  }

  const claims = extractClaims(result);
  const checked = [];
  let contradicted = 0, verified = 0;
  for (const claim of claims) {
    const checker = checkers[claim.kind];
    if (!checker) continue;
    let ok = null;
    try { ok = !!checker(claim.value); } catch { ok = null; } // checker error ≠ contradiction
    checked.push({ ...claim, ok });
    if (ok === true) verified++;
    else if (ok === false) contradicted++;
  }

  const verdict = contradicted > 0 ? 'contradicted' : verified > 0 ? 'verified' : 'unverified';
  return { verdict, checkedAt: now, claims: checked };
}

// Annotate a run-log JSON file in place. Returns the verdict, or null on bad file.
export function annotateFile(file, checkers = DEFAULT_CHECKERS) {
  let entry;
  try { entry = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const verification = verifyRun(entry, checkers);
  entry.verification = verification;
  fs.writeFileSync(file, JSON.stringify(entry, null, 2));
  return verification.verdict;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  let files;
  if (args.includes('--all')) {
    try {
      files = fs.readdirSync(RUN_LOG_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => path.join(RUN_LOG_DIR, f))
        .filter(f => {
          try { return !JSON.parse(fs.readFileSync(f, 'utf8')).verification; } catch { return false; }
        });
    } catch { files = []; }
  } else {
    files = args.filter(a => !a.startsWith('--'));
  }
  if (!files.length) {
    console.log('done-check: nothing to verify');
    process.exit(0);
  }
  let bad = 0;
  for (const f of files) {
    const verdict = annotateFile(f);
    console.log(`${path.basename(f)}: ${verdict || 'malformed'}`);
    if (verdict === 'contradicted') bad++;
  }
  process.exit(bad > 0 ? 2 : 0);
}

if (isMainModule(import.meta.url)) main();
