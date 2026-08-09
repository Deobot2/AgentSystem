#!/usr/bin/env node
// drift-check-run.js — the Windows workstation half of the enforcement drift check (#322).
//
// .github/workflows/enforcement-drift-check.yml already runs this trio daily, but only on
// `runs-on: [self-hosted, Linux]` — so this Windows box's hooks/agents/routines drift is detected
// by nothing. This script is the thing a Windows Scheduled Task can point `node` at to cover it:
// same three checks, same idea (raise a human-needed alert on drift, resolve it on a clean run),
// just invoked by Task Scheduler instead of GitHub Actions cron.
//
// It deliberately does NOT check the brain-sync timer (that already has its own
// tools/install-brain-sync-timer.ps1 -Check, run by the same drift-check-task); duplicating it here
// would just be two things able to raise the same alert for the same cause.
//
// Exit codes:
//   0  clean — no drift on any of the three checks
//   1  drift found on at least one check; a human-needed alert was raised (or re-pinged)
//
// Usage:
//   node tools/drift-check-run.js [--human-needed <script>]
//
// Node builtins only (repo rule for tools/).

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Per-host alert key: this workstation's drift is a different person-task than the runner's. */
export function alertKey(host = hostname()) {
  return `enforcement-drift-${String(host).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

const CHECKS = [
  {
    label: 'Hook deploy + registration drift',
    args: [join(HERE, 'deploy-hooks.js'), '--check', '--require-install'],
    bullet: 'Hook deploy/registration drift detected',
  },
  {
    label: 'Installed agent definition drift',
    args: [join(HERE, 'sync-agents.js'), '--check'],
    bullet: 'Agent definition drift detected',
  },
  {
    label: 'Orphan hard cron routines',
    args: [join(HERE, 'routines.js'), 'verify'],
    bullet: 'Cron routine verification failed (orphan routines or cron mismatch)',
  },
];

/** Run every check with the given spawn function; never throws. Returns per-check results. */
export function runChecks(spawn = defaultSpawn) {
  return CHECKS.map((c) => {
    const r = spawn(process.execPath, c.args);
    const ok = (r.status ?? 1) === 0;
    return { ...c, ok, status: r.status, stdout: r.stdout, stderr: r.stderr };
  });
}

function defaultSpawn(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', cwd: dirname(HERE) });
}

export function raiseArgs(results, host = hostname()) {
  const failed = results.filter((r) => !r.ok);
  return [
    'raise', alertKey(host),
    '--title', `CI/CD enforcement drift detected on ${host}`,
    '--why',
      `Daily drift check on ${host} at ${new Date().toISOString()} found mismatches between `
      + `repo and deployed state:\n${failed.map((f) => `• ${f.bullet}`).join('\n')}`,
    '--action',
      'Run the failing check(s) locally to diagnose:\n'
      + '```bash\n'
      + 'node tools/deploy-hooks.js --check --require-install\n'
      + 'node tools/sync-agents.js --check\n'
      + 'node tools/routines.js verify\n'
      + '```\n\n'
      + 'Then fix the drift and push. Common causes:\n'
      + '• Hooks edited in ~/.claude/hooks/ but not committed to repo or not deployed\n'
      + '• Agent defs edited in .agents/agents/ but sync-agents.js not run\n'
      + '• Cron routine added to config/routines.yml but corresponding job not added to workflow, or vice versa\n\n'
      + `Re-run \`node tools/drift-check-run.js\` on ${host} after fixing to verify and close the alert.`,
  ];
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const value = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const humanNeeded = value('human-needed', join(HERE, 'human-needed.js'));

  const results = runChecks();
  for (const r of results) {
    process.stdout.write(`=== ${r.label} ===\n`);
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.stdout.write(r.ok ? `PASSED: ${r.label}\n` : `FAILED: ${r.label}\n`);
  }

  const driftFound = results.some((r) => !r.ok);
  const runHumanNeeded = (args) => {
    const h = spawnSync(process.execPath, [humanNeeded, ...args], { encoding: 'utf8' });
    if ((h.status ?? 1) !== 0) {
      process.stderr.write(`drift-check-run: could not reach human-needed (${h.status})\n`);
      return false;
    }
    return true;
  };

  if (driftFound) {
    runHumanNeeded(raiseArgs(results));
  } else {
    runHumanNeeded(['resolve', alertKey()]);
  }

  process.exit(driftFound ? 1 : 0);
}
