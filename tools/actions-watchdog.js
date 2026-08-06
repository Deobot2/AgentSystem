#!/usr/bin/env node
// actions-watchdog.js — liveness check for GitHub Actions itself, run from OFF Actions.
//
// Usage:
//   node tools/actions-watchdog.js            # check, raise or resolve the alert
//   node tools/actions-watchdog.js --dry-run  # print the verdict, touch nothing
//   node tools/actions-watchdog.js --max-age-hours 12
//
// Why this exists (#197): Actions was disabled at the repository level for five days and nothing
// noticed, because `runner-health-check.yml` — the watchdog for exactly that outage — is itself an
// Actions workflow. A disable silences the detector along with everything it detects. So this one
// runs on the Mission Control host under a systemd timer (`tools/install-actions-watchdog.sh`),
// which survives an Actions outage.
//
// The alert channel is still a GitHub issue via `human-needed.js`. That is not a contradiction:
// the Issues REST API is unaffected by `actions/permissions.enabled = false`. The recursion this
// closes is Actions-detecting-Actions, not GitHub-detecting-GitHub — a full GitHub outage is
// visible to the operator by other means and is not the failure mode that went unnoticed.
//
// Exit codes: 0 healthy · 1 gh/API failure (cannot tell) · 3 outage detected and alert raised.

import { execFileSync } from 'node:child_process';
import { isMainModule } from './is-main.js';
import { raise, resolve } from './human-needed.js';

export const ALERT_KEY = 'actions-down';

// Quiet-period budget. The repo's own floor is the twice-daily `daily-triage` job (13:00 and 05:00
// UTC), so the longest legitimate gap between runs is ~16h. 24h clears that with margin — a real
// outage is caught within a day, and an ordinary quiet weekend never pages anyone.
export const DEFAULT_MAX_AGE_HOURS = 24;

/**
 * Pure verdict, so the thresholds are testable without a network.
 *
 * `enabled === false` is the loud case (someone turned Actions off). A stale newest-run is the
 * quiet one — Actions can be nominally enabled while the only self-hosted runner is dead, which
 * looks identical from here and deserves the same alert.
 */
export function decide({ enabled, newestRunAt, now = new Date(), maxAgeHours = DEFAULT_MAX_AGE_HOURS }) {
  if (enabled === false) {
    return { down: true, reason: 'GitHub Actions is **disabled at the repository level** — every workflow in the repo, including the watchdogs, is inert.' };
  }
  if (!newestRunAt) {
    return { down: true, reason: 'Actions reports enabled, but the API returned no workflow runs at all.' };
  }
  const ageHours = (now.getTime() - new Date(newestRunAt).getTime()) / 3_600_000;
  if (!Number.isFinite(ageHours)) {
    return { down: true, reason: `Could not read a timestamp from the newest workflow run (\`${newestRunAt}\`).` };
  }
  if (ageHours > maxAgeHours) {
    return {
      down: true,
      ageHours,
      reason: `Actions reports enabled, but the newest workflow run is ${ageHours.toFixed(1)}h old (budget ${maxAgeHours}h). Either runs are not being triggered or the self-hosted runner is dead.`,
    };
  }
  return { down: false, ageHours };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Live probe. Returns `{ enabled, newestRunAt }`; throws if gh cannot answer at all. */
export function probe() {
  const perms = JSON.parse(gh(['api', 'repos/{owner}/{repo}/actions/permissions']));
  let newestRunAt = null;
  try {
    const runs = JSON.parse(gh(['api', 'repos/{owner}/{repo}/actions/runs?per_page=1']));
    newestRunAt = runs.workflow_runs?.[0]?.created_at ?? null;
  } catch {
    // A disabled repo can 404 here. `enabled` already carries the verdict in that case, and a
    // null newestRunAt is itself reported as down when Actions claims to be enabled.
  }
  return { enabled: perms.enabled !== false, newestRunAt };
}

export function parseArgs(argv) {
  const flags = { dryRun: false, maxAgeHours: DEFAULT_MAX_AGE_HOURS };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') flags.dryRun = true;
    else if (argv[i] === '--max-age-hours') flags.maxAgeHours = Number(argv[++i]);
  }
  return flags;
}

if (isMainModule(import.meta.url)) {
  const flags = parseArgs(process.argv.slice(2));

  let state;
  try {
    state = probe();
  } catch (err) {
    // Cannot reach GitHub, so we also cannot raise an issue about it. Fail loudly to the journal
    // rather than resolving the alert on no evidence — `systemctl --user status` shows this.
    console.error(`actions-watchdog: cannot reach GitHub — ${(err.stderr || err.message || '').toString().trim()}`);
    process.exit(1);
  }

  const verdict = decide({ ...state, maxAgeHours: flags.maxAgeHours });

  if (!verdict.down) {
    console.log(`healthy: Actions enabled, newest run ${verdict.ageHours.toFixed(1)}h old`);
    resolve({ key: ALERT_KEY, comment: 'Actions is running again — newest workflow run is inside the freshness budget.', dryRun: flags.dryRun });
    process.exit(0);
  }

  console.error(`OUTAGE: ${verdict.reason}`);
  raise({
    key: ALERT_KEY,
    title: 'GitHub Actions is not running — every workflow in this repo is inert',
    why: `${verdict.reason}\n\nDetected from the Mission Control host by \`tools/actions-watchdog.js\`, deliberately outside Actions: the in-repo watchdogs cannot report an outage that disables them (#197).`,
    action: 'Check `gh api repos/{owner}/{repo}/actions/permissions`. If `enabled` is false, re-enable it:\n\n```bash\ngh api -X PUT repos/{owner}/{repo}/actions/permissions --input - <<\'JSON\'\n{"enabled": true, "allowed_actions": "all"}\nJSON\n```\n\nIf it is already enabled, the self-hosted runner is the likely cause — see `docs/ci-runbook.md`. This alert closes itself on the next check once runs resume.',
    source: 'tools/actions-watchdog.js',
    dryRun: flags.dryRun,
  });
  process.exit(3);
}
