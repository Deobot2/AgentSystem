#!/usr/bin/env node
// pr-checks-watchdog.js — notice an open PR against `main` that produced NONE of the repo's
// required checks.
//
// Usage:
//   node tools/pr-checks-watchdog.js            # check, raise or resolve the alert
//   node tools/pr-checks-watchdog.js --dry-run  # print the verdict, touch nothing
//   node tools/pr-checks-watchdog.js --grace-minutes 45
//
// Why this exists: PR #326 sat open against `main` having dispatched not one workflow run — no
// tests, no Sam audit, no linked-issue gate. Its head branch conflicted with `main`, so GitHub
// could not compute `refs/pull/326/merge`, and GitHub does not fire `pull_request` events for a
// PR it cannot merge. Nothing in the repo noticed. That is the #228/#229 class again: an ABSENT
// required check is not a FAILING one, and only the failing case is loud.
//
// Predicate is "none of the required contexts are present", not "any is missing". A PR missing
// *some* required check is already visibly BLOCKED by branch protection and GitHub refuses the
// merge — that case is loud and handled. The invisible case, and the only one worth an alert, is
// the total no-show. "Any missing" would also be chronically noisy: which optional checks attach
// to a PR varies with `paths` filters (`Workflow files must be loadable` runs on #327 but not
// #328), and a check still in flight looks identical to one that never dispatched.
//
// Note "zero check runs at all" would NOT have caught #326 — it had exactly one, from GitGuardian.
// The predicate has to be about *this repo's required contexts*, not raw check count.
//
// Runs off Actions, on the same systemd timer as `actions-watchdog.js`, for the same reason (#197):
// a repo-wide Actions outage is one of the things that produces this exact symptom, and a detector
// hosted in Actions cannot report an outage that disables it.
//
// Exit codes: 0 healthy · 1 gh/API failure (cannot tell) · 3 unchecked PR found and alert raised.

import { execFileSync } from 'node:child_process';
import { isMainModule } from './is-main.js';
import { raise, resolve } from './human-needed.js';

export const ALERT_KEY = 'pr-missing-required-checks';

// A PR opened seconds ago has no checks yet and that is normal. The timer runs hourly, so a grace
// window well under an hour still catches the real thing on the first pass after it appears.
export const DEFAULT_GRACE_MINUTES = 30;

/**
 * Pure verdict, so the predicate is testable without a network.
 *
 * @param prs   [{ number, url, title, isDraft, createdAt, checkNames: string[] }]
 * @param requiredContexts  branch-protection contexts for `main`
 * @returns { unchecked: [...], reason? }
 */
export function decide({ prs, requiredContexts, now = new Date(), graceMinutes = DEFAULT_GRACE_MINUTES }) {
  // No required contexts means branch protection is not configured (or unreadable). Reporting
  // every PR as unchecked in that case would be nonsense — say nothing and let the operator's
  // branch-protection tooling own that gap.
  if (!requiredContexts?.length) return { unchecked: [] };

  const required = new Set(requiredContexts);
  const unchecked = prs.filter((pr) => {
    const ageMinutes = (now.getTime() - new Date(pr.createdAt).getTime()) / 60_000;
    if (!Number.isFinite(ageMinutes) || ageMinutes < graceMinutes) return false;
    return !(pr.checkNames ?? []).some((name) => required.has(name));
  });

  if (!unchecked.length) return { unchecked: [] };
  return {
    unchecked,
    reason: unchecked
      .map((pr) => `- #${pr.number} ${pr.url} — ${pr.title}`)
      .join('\n'),
  };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Live probe. Returns `{ prs, requiredContexts }`; throws if gh cannot answer at all. */
export function probe() {
  let requiredContexts = [];
  try {
    const protection = JSON.parse(gh(['api', 'repos/{owner}/{repo}/branches/main/protection/required_status_checks']));
    requiredContexts = protection.contexts ?? [];
  } catch {
    // Unreadable protection (token scope, or none configured) — `decide` treats an empty list as
    // "cannot judge" and stays quiet rather than alerting on every open PR.
  }

  const raw = JSON.parse(gh([
    'pr', 'list', '--base', 'main', '--state', 'open', '--limit', '100',
    '--json', 'number,url,title,isDraft,createdAt,statusCheckRollup',
  ]));

  const prs = raw.map((pr) => ({
    number: pr.number,
    url: pr.url,
    title: pr.title,
    isDraft: pr.isDraft,
    createdAt: pr.createdAt,
    checkNames: (pr.statusCheckRollup ?? []).map((c) => c.name ?? c.context).filter(Boolean),
  }));

  return { prs, requiredContexts };
}

export function parseArgs(argv) {
  const flags = { dryRun: false, graceMinutes: DEFAULT_GRACE_MINUTES };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') flags.dryRun = true;
    else if (argv[i] === '--grace-minutes') flags.graceMinutes = Number(argv[++i]);
  }
  return flags;
}

if (isMainModule(import.meta.url)) {
  const flags = parseArgs(process.argv.slice(2));

  let state;
  try {
    state = probe();
  } catch (err) {
    console.error(`pr-checks-watchdog: cannot reach GitHub — ${(err.stderr || err.message || '').toString().trim()}`);
    process.exit(1);
  }

  const verdict = decide({ ...state, graceMinutes: flags.graceMinutes });

  if (!verdict.unchecked.length) {
    console.log(`healthy: ${state.prs.length} open PR(s) against main, all have at least one required check`);
    resolve({ key: ALERT_KEY, comment: 'Every open PR against `main` is producing required checks again.', dryRun: flags.dryRun });
    process.exit(0);
  }

  console.error(`UNCHECKED PRs against main:\n${verdict.reason}`);
  raise({
    key: ALERT_KEY,
    title: 'Open PR against `main` produced none of the required checks',
    why: `These PRs are open against \`main\` and have not produced a single one of the required contexts (${state.requiredContexts.join(', ')}):\n\n${verdict.reason}\n\nA required check that never runs is not the same as one that fails — the absent case is what let PRs through unaudited in #228 and #229. Detected by \`tools/pr-checks-watchdog.js\` from the Mission Control host, outside Actions (#197).`,
    action: 'For each PR above, find why no workflow dispatched:\n\n1. **Merge conflict** — the usual cause. `gh pr view <n> --json mergeable` returning `CONFLICTING` means GitHub cannot build `refs/pull/<n>/merge` and fires no `pull_request` events at all. Rebase or merge `main` into the head branch; the checks appear on the next push.\n2. **Actions disabled or runner dead** — `node tools/actions-watchdog.js --dry-run`.\n3. **`paths`/`paths-ignore` filter** excluding the diff — see `docs/ci-runbook.md`.\n\nThis alert closes itself once every open PR has at least one required check.',
    source: 'tools/pr-checks-watchdog.js',
    dryRun: flags.dryRun,
  });
  process.exit(3);
}
