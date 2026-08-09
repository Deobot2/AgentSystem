#!/usr/bin/env node
// actions-watchdog.js — liveness check for GitHub Actions itself, run from OFF Actions.
//
// Usage:
//   node tools/actions-watchdog.js            # check, raise or resolve the alert
//   node tools/actions-watchdog.js --dry-run  # print the verdict, touch nothing
//   node tools/actions-watchdog.js --max-age-hours 12
//   node tools/actions-watchdog.js --check-heartbeat        # is this host's timer alive and working?
//   node tools/actions-watchdog.js --print-heartbeat-path   # read-only: where this host would stamp
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { isMainModule } from './is-main.js';
import { raise, resolve } from './human-needed.js';
import { agentMemoryRoot } from './graph/graph-lib.js';

export const ALERT_KEY = 'actions-down';

// Quiet-period budget. The repo's own floor is the twice-daily `daily-triage` job (13:00 and 05:00
// UTC), so the longest legitimate gap between runs is ~16h. 24h clears that with margin — a real
// outage is caught within a day, and an ordinary quiet weekend never pages anyone.
export const DEFAULT_MAX_AGE_HOURS = 24;

// #313: the watchdog only ever spoke when it raised an alert, so a dead hourly timer and a healthy
// one were byte-identical from this repo. Every completed run now stamps a heartbeat into
// ~/agent-memory/nexus/ — ONE FILE PER HOST, not a shared/appended log: two hosts writing the same
// shared file is exactly the class of conflict CLAUDE.md's "graph.json is generated, not authored"
// guidance warns about, and brain-sync would fight over it on every sync. A per-host file with the
// hostname in its name never collides. It is also not gitignored like the append-only logs
// (session-log.jsonl etc.) — those are excluded because they conflict on every sync and hold no
// facts; this is a single small overwritten state file, exactly the shape of other checked-in
// repo-brain content.
//
// The watchdog itself cannot assert its own staleness: a dead timer runs no code, so "is my last
// heartbeat fresh" has to be asked by something else, on a separate schedule — see
// decideHeartbeatFreshness() below and its use in enforcement-drift-check.yml.
export function heartbeatPath(host = hostname(), root = agentMemoryRoot()) {
  return join(root, 'nexus', `actions-watchdog-heartbeat-${host}.json`);
}

// #362: the heartbeat used to be stamped ONLY after `probe()` returned — i.e. only once the run
// had already reached GitHub and produced a verdict. Every failure before that point (`gh` not on
// the unit's minimal PATH, `gh` unauthenticated for the timer's user, a network error, an API 5xx,
// any crash) took the catch below and exited 1 having written nothing. So the heartbeat proved
// "the watchdog ran AND reached GitHub", never "the watchdog ran" — and the one fault it exists to
// name (a timer that fires hourly and dies hourly) produced exactly the same evidence as a timer
// that never fired at all: no file. Worse, that state was PERMANENTLY unclearable — the alert
// could only be closed by a run that succeeded, which is the case that was never in doubt.
//
// So liveness and verdict are now two separate fields, stamped on every completed run:
//   ran      — always true in a file that exists; the file's existence IS the liveness proof
//   verdict  — 'healthy' | 'down' | 'error'; what the run concluded, or that it could not conclude
// `error` is a heartbeat: the timer is alive and the check is broken, which is a third state and
// must not be reported as either "healthy and quiet" or "dead timer".
export function writeHeartbeat({ verdict, ageHours = null, reason = null, host = hostname(), now = new Date(), path = heartbeatPath(host) } = {}) {
  const payload = { timestamp: now.toISOString(), host, ran: true, verdict, ageHours, reason };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

/**
 * Stamp a heartbeat, but never let stamping it be the reason a run dies. The heartbeat is
 * diagnostics; the watchdog's own verdict is the product. A read-only ~/agent-memory or a full
 * disk should degrade the diagnostics, not suppress the outage alert.
 */
export function tryWriteHeartbeat(args) {
  try { return writeHeartbeat(args); }
  catch (err) {
    console.error(`actions-watchdog: could not stamp heartbeat — ${(err.message || err).toString().trim()}`);
    return null;
  }
}

export const DEFAULT_HEARTBEAT_MAX_AGE_HOURS = 3;

export function decideHeartbeatFreshness({ heartbeat, now = new Date(), maxAgeHours = DEFAULT_HEARTBEAT_MAX_AGE_HOURS }) {
  if (!heartbeat || !heartbeat.timestamp) {
    return { stale: true, reason: 'no actions-watchdog heartbeat found — the timer may never have run on this host' };
  }
  const ageHours = (now.getTime() - new Date(heartbeat.timestamp).getTime()) / 3_600_000;
  if (!Number.isFinite(ageHours)) {
    return { stale: true, reason: `heartbeat timestamp is unparseable (${heartbeat.timestamp})` };
  }
  if (ageHours > maxAgeHours) {
    return { stale: true, ageHours, reason: `actions-watchdog heartbeat is ${ageHours.toFixed(1)}h old (budget ${maxAgeHours}h) — the hourly timer looks dead` };
  }
  // Fresh, so the timer is demonstrably alive — a different fault from a dead one, and it gets its
  // own word. Reported as `failing`, not `stale`: telling a human "the timer looks dead" when the
  // timer is fine and `gh` is unauthenticated sends them to the wrong host state entirely.
  if (heartbeat.verdict === 'error') {
    return {
      stale: false, failing: true, ageHours,
      reason: `the actions-watchdog timer IS firing (heartbeat ${ageHours.toFixed(1)}h old) but every run fails before it can check anything: ${heartbeat.reason || 'no reason recorded'}`,
    };
  }
  return { stale: false, failing: false, ageHours };
}

export function readHeartbeat(path = heartbeatPath()) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

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
  const flags = {
    dryRun: false, maxAgeHours: DEFAULT_MAX_AGE_HOURS,
    checkHeartbeat: false, heartbeatMaxAgeHours: DEFAULT_HEARTBEAT_MAX_AGE_HOURS,
    printHeartbeatPath: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') flags.dryRun = true;
    else if (argv[i] === '--max-age-hours') flags.maxAgeHours = Number(argv[++i]);
    else if (argv[i] === '--check-heartbeat') flags.checkHeartbeat = true;
    else if (argv[i] === '--print-heartbeat-path') flags.printHeartbeatPath = true;
    else if (argv[i] === '--heartbeat-max-age-hours') flags.heartbeatMaxAgeHours = Number(argv[++i]);
  }
  return flags;
}

if (isMainModule(import.meta.url)) {
  const flags = parseArgs(process.argv.slice(2));

  // Diagnostic only, and read-only. The heartbeat path is derived from AGENT_MEMORY_ROOT (or $HOME)
  // *inside this process*, so a reader that reconstructs it in shell can be wrong in exactly the
  // way that matters: a systemd unit carrying a different HOME/AGENT_MEMORY_ROOT than the job doing
  // the checking would stamp a real heartbeat somewhere --check-heartbeat never looks (#362, fault
  // c). Asking the code where it would look is the only answer that cannot disagree with the code.
  if (flags.printHeartbeatPath) {
    console.log(heartbeatPath());
    process.exit(0);
  }

  if (flags.checkHeartbeat) {
    const heartbeat = readHeartbeat();
    const verdict = decideHeartbeatFreshness({ heartbeat, maxAgeHours: flags.heartbeatMaxAgeHours });
    if (verdict.stale) {
      console.error(`STALE: ${verdict.reason}`);
      process.exit(1);
    }
    if (verdict.failing) {
      console.error(`FAILING: ${verdict.reason}`);
      process.exit(1);
    }
    console.log(`fresh: actions-watchdog heartbeat is ${verdict.ageHours.toFixed(1)}h old (verdict: ${heartbeat.verdict})`);
    process.exit(0);
  }

  let state;
  try {
    state = probe();
  } catch (err) {
    // Cannot reach GitHub, so we also cannot raise an issue about it. Fail loudly to the journal
    // rather than resolving the alert on no evidence — `systemctl --user status` shows this.
    //
    // The heartbeat is stamped FIRST and unconditionally (#362). This is the path a `gh` that is
    // missing, unauthenticated or rate-limited takes, and it used to write nothing at all — which
    // made a broken-but-firing timer indistinguishable from a dead one, and left the drift alert
    // with no reachable way to clear. The stamp records that the run happened and why it could not
    // conclude; `--check-heartbeat` reports that as FAILING, not STALE.
    const why = (err.stderr || err.message || '').toString().trim();
    console.error(`actions-watchdog: cannot reach GitHub — ${why}`);
    tryWriteHeartbeat({ verdict: 'error', reason: `probe failed: ${why || 'unknown error'}` });
    process.exit(1);
  }

  const verdict = decide({ ...state, maxAgeHours: flags.maxAgeHours });

  if (!verdict.down) {
    console.log(`healthy: Actions enabled, newest run ${verdict.ageHours.toFixed(1)}h old`);
    tryWriteHeartbeat({ verdict: 'healthy', ageHours: verdict.ageHours });
    resolve({ key: ALERT_KEY, comment: 'Actions is running again — newest workflow run is inside the freshness budget.', dryRun: flags.dryRun });
    process.exit(0);
  }

  console.error(`OUTAGE: ${verdict.reason}`);
  tryWriteHeartbeat({ verdict: 'down', ageHours: verdict.ageHours ?? null, reason: verdict.reason });
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
