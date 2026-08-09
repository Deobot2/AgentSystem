#!/usr/bin/env node
// repo-sync.js — fast-forward the AgentSystem checkout at session start (#341).
//
// AgentSystem is cloned on every machine that uses the harness, but only one of them is Mission
// Control. The others are pure consumers: they run the agents, hooks and tools out of a checkout
// that nobody remembers to `git pull`. So a fix merged to main reaches one host immediately and the
// rest whenever someone happens to notice — which is the same silent-drift shape as #302 and #298.
//
// This is deliberately the most timid tool in the repo. It runs unattended on every host, so every
// case except "on main, clean, and a fast-forward exists" is a silent no-op:
//
//   * feature branch      -> skip. Never move someone's work.
//   * dirty tree          -> skip. `git pull` on a dirty tree either fails or stashes; both are
//                            surprises to a human who left an edit open.
//   * no origin remote    -> skip.
//   * detached HEAD       -> skip.
//   * diverged main       -> `--ff-only` refuses, and we do not escalate to a merge or a reset.
//
// It never pushes. Publishing code stays a PR through Sam's gate; this only consumes what main
// already has.
//
// SessionStart only, never on the host timer: rewriting files under a running session means the
// model's picture of the tree silently stops matching the tree.
//
// Usage:
//   node tools/repo-sync.js [--path <repo>] [--dry-run] [--verbose]
//
// Exit code is 0 in every non-catastrophic case, including every skip — this is opportunistic
// housekeeping, and a hook worker treating "nothing to do" as a failure trains people to ignore it.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main.js';

export const SYNC_BRANCH = 'main';

/**
 * Should this checkout be pulled? Pure, so the refusals are testable without a git fixture.
 * @param {{branch: string, dirty: string, hasOrigin: boolean}} state
 */
export function decide({ branch, dirty, hasOrigin }) {
  if (!hasOrigin) return { sync: false, reason: 'no origin remote' };
  if (!branch || branch === 'HEAD') return { sync: false, reason: 'detached HEAD' };
  if (branch !== SYNC_BRANCH) return { sync: false, reason: `on branch ${branch}, not ${SYNC_BRANCH}` };
  if (dirty && dirty.trim()) return { sync: false, reason: 'uncommitted local changes' };
  return { sync: true, reason: `clean ${SYNC_BRANCH}` };
}

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return { code: r.status ?? 1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/** Read the three facts `decide` needs. */
export function readState(root) {
  return {
    branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out,
    dirty: git(root, ['status', '--porcelain']).out,
    hasOrigin: git(root, ['remote']).out.split('\n').includes('origin'),
  };
}

export function repoSync(root, { dryRun = false } = {}) {
  if (!existsSync(join(root, '.git'))) return { synced: false, reason: 'not a git checkout' };

  const decision = decide(readState(root));
  if (!decision.sync) return { synced: false, reason: decision.reason };
  if (dryRun) return { synced: false, dryRun: true, reason: decision.reason };

  const pull = git(root, ['pull', '--ff-only', '--quiet', 'origin', SYNC_BRANCH]);
  if (pull.code !== 0) {
    // The expected failure is a diverged main, which --ff-only refuses. That is the tool working.
    return { synced: false, reason: `fast-forward refused: ${(pull.err || pull.out).split('\n')[0]}` };
  }
  return { synced: true, reason: decision.reason, head: git(root, ['rev-parse', '--short', 'HEAD']).out };
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flagValue = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : null;
  };
  const dryRun = argv.includes('--dry-run');
  const verbose = argv.includes('--verbose');
  // Default: the checkout this file lives in. realpath, because ~/dev/AgentSystem is a symlink on
  // the hosts that matter and git resolves the two spellings to the same repo either way.
  const root = resolve(flagValue('path') || join(dirname(fileURLToPath(import.meta.url)), '..'));

  const r = repoSync(root, { dryRun });
  if (r.synced) process.stdout.write(`repo-sync: pulled ${SYNC_BRANCH} (${r.head})\n`);
  else if (r.dryRun) process.stdout.write(`repo-sync: would pull ${SYNC_BRANCH} — ${r.reason}\n`);
  else if (verbose) process.stdout.write(`repo-sync: skipped — ${r.reason}\n`);
  // Silence on skip is the contract: this fires on every session start on every host.
  process.exit(0);
}
