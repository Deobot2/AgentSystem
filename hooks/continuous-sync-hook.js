'use strict';
// continuous-sync-hook.js — the session half of continuous sync (#341).
//
// Registered twice in HOOK_REGISTRY, with the phase in the command string:
//   SessionStart --phase=start  ->  brain-sync --pull-only, then repo-sync (fast-forward main)
//   SessionEnd   --phase=end    ->  brain-sync (commit + push)
//
// Two-phase, exactly like session-auto-rename-hook.js and for the same reason: the hook's
// registered timeout is 5s and this work is `git fetch` against two remotes, which on a cold link
// is longer than that. So the hook spawns a detached worker, prints OK and exits in ~80ms; the
// worker does the network calls after the session has already started.
//
// Why the split of duties:
//   * memory is pulled at start and pushed at end, so a session begins with what other hosts knew
//     and ends by publishing what it learned;
//   * code is only ever pulled at start. Rewriting the checkout under a running session means the
//     model's picture of the tree silently stops matching the tree. repo-sync is not on the
//     15-minute timer for the same reason.
//
// Nothing here decides anything about git. The hook picks a phase and shells out to
// tools/brain-sync-run.js and tools/repo-sync.js, which are ESM and separately tested. That
// boundary is also what lets the host timer run the identical code path with no session involved.
//
// A hook must never fail a session: every path here exits 0.

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = process.env.CONTINUOUS_SYNC_HOME || os.homedir();
const LOG = process.env.CONTINUOUS_SYNC_LOG
  || path.join(HOME, 'agent-memory', 'nexus', 'continuous-sync.log');

// Set on anything we spawn, so a nested Claude session (the headless namer, a dispatched agent)
// cannot recurse into another sync.
const CHILD_ENV_GUARD = 'AGENT_CONTINUOUS_SYNC_CHILD';

const PHASES = ['start', 'end'];

/** Each script gets its own budget; the worker is detached, so this is only a runaway guard. */
const STEP_TIMEOUT_MS = 5 * 60 * 1000;

/** Find the repo's tools/ directory — repo checkout, deployed copy, or explicit override. */
function findToolsDir() {
  const candidates = [
    process.env.AGENT_TOOLS_ROOT,
    path.resolve(__dirname, '..', 'tools'),
    path.join(HOME, 'dev', 'AgentSystem', 'tools'),
    path.join(HOME, 'Documents', 'DEV', 'AgentSystem', 'tools'),
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      // realpath: ~/dev/AgentSystem is a symlink on the hosts that matter, and a tool that checks
      // `isMainModule` never runs main() when handed the symlinked path (CLAUDE.md → Is-main).
      if (fs.existsSync(path.join(dir, 'brain-sync-run.js'))) return fs.realpathSync(dir);
    } catch { /* keep looking */ }
  }
  return null;
}

/**
 * What the worker runs for a phase, in order.
 * @returns {Array<{script: string, args: string[]}>}
 */
function workerPlan(phase, toolsDir) {
  if (!toolsDir) return [];
  if (phase === 'start') {
    return [
      { script: path.join(toolsDir, 'brain-sync-run.js'), args: ['--pull-only'] },
      { script: path.join(toolsDir, 'repo-sync.js'), args: [] },
    ];
  }
  if (phase === 'end') {
    return [{ script: path.join(toolsDir, 'brain-sync-run.js'), args: [] }];
  }
  return [];
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line, 'utf8');
  } catch { /* logging must never break a hook */ }
}

// ── worker (slow path, runs detached) ────────────────────────────────────────

function runWorker(phase) {
  if (process.env[CHILD_ENV_GUARD] === '1') return;

  const toolsDir = findToolsDir();
  const plan = workerPlan(phase, toolsDir);
  if (!plan.length) { log(`${phase}: nothing to run (tools dir ${toolsDir || 'not found'})`); return; }

  for (const step of plan) {
    const name = path.basename(step.script);
    const r = spawnSync(process.execPath, [step.script, ...step.args], {
      encoding: 'utf8',
      timeout: STEP_TIMEOUT_MS,
      env: { ...process.env, [CHILD_ENV_GUARD]: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const code = r.error ? `error ${r.error.message.split('\n')[0]}` : `exit ${r.status}`;
    const said = (r.stdout || r.stderr || '').trim().split('\n')[0] || '';
    log(`${phase}: ${name} ${step.args.join(' ')} -> ${code}${said ? ` — ${said}` : ''}`);
    // No early return. brain-sync failing (a conflict, say — already alerted by brain-sync-run)
    // has nothing to do with whether the code checkout can fast-forward.
  }
}

// ── hook (fast path) ─────────────────────────────────────────────────────────

function runHook(phase) {
  if (process.env[CHILD_ENV_GUARD] === '1') return;
  // Payload is read only to drain stdin; nothing here depends on its contents, so malformed JSON
  // is not a reason to skip the sync.
  try { fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }

  const child = spawn(process.execPath, [__filename, '--worker', `--phase=${phase}`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

// ── entrypoint ───────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const phaseArg = argv.find((a) => a.startsWith('--phase='));
  const phase = phaseArg ? phaseArg.slice('--phase='.length) : 'start';
  const isWorker = argv.includes('--worker');

  // Nothing is printed, ever. A SessionStart hook's stdout is injected into the session as context,
  // so an "OK" here is not a status line for a human — it is a token prepended to every single
  // session, forever, that says nothing. Whether the sync ran belongs in the log file, which is
  // where runWorker puts it. Exit 0 is the whole signal the hook runner needs.
  try {
    if (isWorker) runWorker(phase);
    else runHook(phase);
  } catch (err) {
    log(`error (${phase}): ${err && err.message}`);
  }
  process.exit(0);
}

module.exports = { workerPlan, findToolsDir, PHASES, CHILD_ENV_GUARD };
