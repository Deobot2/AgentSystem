// event-dispatcher.js — drains the event bus (tools/event-bus.js), executing each event
// through a typed handler with retry/backoff and dead-letter handled by the bus itself.
//
// Built-in handlers:
//   run-tool     payload: { script, args? }  — run a Node script from tools/ (path-confined)
//   spawn-agent  payload: { agent, prompt, cwd? } — spawn `claude --bg --agent <agent> <prompt>`
//   noop         payload: anything — completes immediately (testing/heartbeat)
//
// Run modes:
//   node tools/event-dispatcher.js --drain [--max=N]   one pass, exit when queue empty
//   (schedule the drain every few minutes via setup-scheduled-tasks.ps1 / cron)
//
// Design: the dispatcher is stateless. All durability lives in the bus's files, so a
// crashed drain loses nothing — recoverStale() requeues anything stuck in processing/.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import * as bus from './event-bus.js';
import { claudeBgArgs } from './mission-control/claude-args.js';
import { isMainModule } from './is-main.js';

const TOOLS_ROOT = path.dirname(fileURLToPath(import.meta.url));

export function runToolHandler(payload) {
  if (!payload || !payload.script) throw new Error('run-tool requires payload.script');
  // Confine to tools/ — events are data; never let one execute an arbitrary path.
  // realpathSync resolves ../ and symlinks before the prefix check, so a symlink
  // planted inside tools/ pointing elsewhere still gets rejected.
  const resolved = path.resolve(TOOLS_ROOT, payload.script);
  if (!fs.existsSync(resolved)) throw new Error(`run-tool script not found: ${resolved}`);
  const real = fs.realpathSync(resolved);
  const realRoot = fs.realpathSync(TOOLS_ROOT);
  if (!real.startsWith(realRoot + path.sep) && path.dirname(real) !== realRoot) {
    throw new Error(`run-tool script escapes tools/: ${payload.script}`);
  }
  const args = Array.isArray(payload.args) ? payload.args.map(String) : [];
  const out = execFileSync(process.execPath, [resolved, ...args], {
    encoding: 'utf8', timeout: 5 * 60 * 1000,
  });
  return out.slice(-2000);
}

// cmd.exe quoting for one argument: wrap in double quotes, double any embedded
// quotes (msvcrt argv rules), and flatten newlines — a raw newline would end the
// `cmd /c` command line and let payload content run as a second command.
export function cmdQuote(arg) {
  return '"' + String(arg).replace(/"/g, '""').replace(/[\r\n]+/g, ' ') + '"';
}

export function spawnAgentHandler(payload) {
  if (!payload || !payload.agent || !payload.prompt) {
    throw new Error('spawn-agent requires payload.agent and payload.prompt');
  }
  // Agent names are our own roster ids — strict allowlist shape, never free text.
  const agent = String(payload.agent);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(agent)) throw new Error(`spawn-agent invalid agent name: ${agent}`);
  // Optional per-task model override (full id, e.g. claude-sonnet-5). A spawn requeued after a
  // concurrency-cap rejection must keep its tier — dropping it silently downgrades the task to the
  // agent's default. Same allowlist shape as the agent name because it is interpolated below.
  const model = payload.model ? String(payload.model) : null;
  if (model && !/^[A-Za-z0-9._-]{1,64}$/.test(model)) throw new Error(`spawn-agent invalid model: ${model}`);
  const cwd = payload.cwd && fs.existsSync(payload.cwd) ? payload.cwd : undefined;
  const opts = { encoding: 'utf8', timeout: 60 * 1000, cwd };
  const modelFlag = model ? ` --model ${model}` : '';
  const res = process.platform === 'win32'
    // claude is a .cmd shim on Windows — needs a shell. Build the command string
    // ourselves with explicit quoting so payload.prompt can never break out;
    // spawnSync's args-array + shell:true does NOT escape.
    // The prompt is the positional -- `--bg -p` is rejected by the CLI, see claude-args.js.
    ? spawnSync(`claude --bg --agent ${agent}${modelFlag} ${cmdQuote(payload.prompt)}`, { ...opts, shell: true })
    : spawnSync('claude', claudeBgArgs({ agent, prompt: payload.prompt, model }), opts);
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`claude --bg exit ${res.status}: ${out.slice(-300)}`);
  return out.trim().slice(-300);
}

export const HANDLERS = {
  'run-tool': runToolHandler,
  'spawn-agent': spawnAgentHandler,
  'noop': () => 'ok',
};

// One drain pass. opts: { root, handlers, max, now, staleMs }.
// Returns { processed, completed, requeued, dead, recovered }.
export function drain(opts) {
  const o = opts || {};
  const handlers = { ...HANDLERS, ...(o.handlers || {}) };
  const recovered = bus.recoverStale(o.root, o.staleMs, o.now);
  const summary = { processed: 0, completed: 0, requeued: 0, dead: 0, recovered };
  const max = Number.isInteger(o.max) ? o.max : 100;
  while (summary.processed < max) {
    const claim = bus.claimNext(o.root, o.now);
    if (!claim) break;
    summary.processed++;
    const handler = handlers[claim.event.type];
    try {
      if (!handler) throw new Error(`no handler for event type "${claim.event.type}"`);
      const result = handler(claim.event.payload, claim.event);
      bus.complete(claim, o.root, result);
      summary.completed++;
    } catch (err) {
      const outcome = bus.fail(claim, err, o.root, o.now);
      if (outcome === 'dead') summary.dead++; else summary.requeued++;
    }
  }
  return summary;
}


function main() {
  const args = process.argv.slice(2);
  const maxArg = args.find(a => a.startsWith('--max='));
  const summary = drain({ max: maxArg ? parseInt(maxArg.slice(6), 10) : 100 });
  const s = bus.stats();
  console.log(`event-dispatcher: processed=${summary.processed} completed=${summary.completed} ` +
    `requeued=${summary.requeued} dead=${summary.dead} recovered=${summary.recovered} ` +
    `| queue: pending=${s.pending} dead=${s.dead}`);
  process.exit(0);
}

if (isMainModule(import.meta.url)) main();
