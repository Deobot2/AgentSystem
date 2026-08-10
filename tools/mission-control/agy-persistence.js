#!/usr/bin/env node
/**
 * LINUX MISSION-CONTROL HOST COMPONENT: Runs on dedicated Linux host only. Not compatible with Windows.
 *
 * Graceful fallback: if tmux unavailable, falls back to spawnDirect() for detached execution
 * (critical for Windows dev environments).
 *
 * Antigravity CLI Persistence Wrapper
 * Spawns `agy` in tmux sessions for background execution
 */

import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isMainModule } from '../is-main.js';

const HOME = homedir();
const LOG_BASE = join(HOME, '.agy-mission-control');
mkdirSync(LOG_BASE, { recursive: true });

// Never default to --dangerously-skip-permissions. Must be explicitly opted in
// via env var (matches agy-dispatcher.js confirmation-required stance).
const ALLOW_SKIP_PERMISSIONS = process.env.AGY_ALLOW_DANGEROUS_SKIP_PERMISSIONS === '1' || process.env.AGY_ALLOW_DANGEROUS_SKIP_PERMISSIONS === 'true';

// agy CLI argv for one headless run. Flag names per `agy --help`:
//   --agent <name>        agent from the installed plugin roster (`agy agents`)
//   --conversation <id>   resume by ID. NOT `--continue <id>` — `--continue` is a
//                         boolean ("most recent conversation") and swallowing an ID
//                         after it leaves the ID as a stray positional arg.
export function agyArgs({ prompt, repoPath, model, agent, continueId }) {
  const args = ['-p', prompt];
  if (agent) args.push('--agent', agent);
  if (model) args.push('--model', model);
  if (continueId) args.push('--conversation', continueId);
  if (ALLOW_SKIP_PERMISSIONS) args.push('--dangerously-skip-permissions');
  args.push('--add-dir', repoPath);
  return args;
}

// tmux-or-direct is decided per spawn, by whether the tmux call below errors or exits non-zero.
// A host without tmux therefore keeps working, but every "persistent" session is really a
// detached child that nothing can attach to, reattach after a restart, or pipe a log from. That
// is a real capability loss and it happened silently — /health reports this so it does not.
//
// Probed once and cached: install tmux and restart the server to pick it up. A per-request
// subprocess to answer a health check would cost more than the accuracy is worth.
let tmuxAvailable = null;
export function persistenceMode() {
  if (tmuxAvailable === null) {
    const probe = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
    tmuxAvailable = !probe.error && probe.status === 0;
  }
  return tmuxAvailable ? 'tmux' : 'direct';
}

export async function spawnAgyPersistent({ prompt, repoPath, model, agent, continueId }) {
  if (!existsSync(repoPath)) throw new Error(`Repo not found: ${repoPath}`);

  const timestamp = Date.now();
  const sessionId = `agy-${timestamp}`;
  const tmuxSessionName = `mc-${sessionId}`;
  const logPath = join(LOG_BASE, `${sessionId}.log`);
  const metaPath = join(LOG_BASE, `${sessionId}.json`);

  const args = agyArgs({ prompt, repoPath, model, agent, continueId });

  return new Promise((resolve, reject) => {
    // Build tmux command with separate argv (NO shell interpretation of user input)
    // tmux new-session -d -s <name> -c <cwd> -- <command> <arg1> <arg2> ...
    // The -- separates tmux options from the command to execute
    const tmuxCmd = ['new-session', '-d', '-s', tmuxSessionName, '-c', repoPath, '--', 'agy'].concat(args);

    const tmux = spawn('tmux', tmuxCmd, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME },
      // NO shell: true — spawn uses execvp, which does NOT interpret shell metacharacters
    });

    tmux.on('error', () => spawnDirect({ args, repoPath, model, logPath, sessionId }).then(resolve).catch(reject));

    tmux.on('close', (code) => {
      if (code !== 0) return spawnDirect({ args, repoPath, model, logPath, sessionId }).then(resolve).catch(reject);

      // Setup log capture via tmux pipe-pane (only logPath is embedded in shell, which is safe—it's generated, not user input)
      const pipePaneCmd = spawn('tmux', ['pipe-pane', '-t', tmuxSessionName, '-o', `cat >> '${logPath}'`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      pipePaneCmd.on('close', () => {
        // Get PID of process in tmux session
        const pidCmd = spawn('tmux', ['list-panes', '-t', tmuxSessionName, '-F', '#{pane_pid}'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let pidOut = '';
        pidCmd.stdout?.on('data', d => { pidOut += d.toString(); });
        pidCmd.on('close', () => {
          const pid = parseInt(pidOut.trim());
          const conversationId = sessionId;

          writeFileSync(metaPath, JSON.stringify({
            id: sessionId, tmuxSessionName, pid: pid || null, logPath, conversationId,
            spawnedAt: new Date().toISOString(), model, repoPath, prompt: prompt.slice(0, 200),
          }, null, 2));

          resolve({ tmuxSessionName, pid: pid || null, logPath, conversationId, spawnedAt: new Date().toISOString() });
        });
      });
    });
  });
}

// tmux missing or failed: run agy detached instead. Returns tmuxSessionName: null —
// reporting a name for a session tmux never created sent /stop down the
// `tmux kill-session` branch, which fails, resolves exitCode 0 anyway, and marks the
// session exited while the real agy process kept running. Null routes /stop to the pid.
async function spawnDirect({ args, repoPath, model, logPath, sessionId }) {
  return new Promise((resolve) => {
    const agy = spawn('agy', args, { cwd: repoPath, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME } });
    agy.unref();
    const pid = agy.pid;

    agy.stdout?.on('data', d => { appendFileSync(logPath, d.toString()); });
    agy.stderr?.on('data', d => { appendFileSync(logPath, d.toString()); });

    const conversationId = sessionId;
    const metaPath = join(LOG_BASE, `${sessionId}.json`);
    writeFileSync(metaPath, JSON.stringify({
      id: sessionId, tmuxSessionName: null, pid, logPath, conversationId,
      spawnedAt: new Date().toISOString(), model, repoPath, prompt: args[1].slice(0, 200), method: 'direct',
    }, null, 2));

    resolve({ tmuxSessionName: null, pid, logPath, conversationId, spawnedAt: new Date().toISOString() });
  });
}

export async function stopAgyPersistent({ tmuxSessionName }) {
  return new Promise((resolve) => {
    const kill = spawn('tmux', ['kill-session', '-t', tmuxSessionName], { stdio: ['ignore', 'pipe', 'pipe'] });
    kill.on('close', (code) => { resolve({ exitCode: code || 0, exitedAt: new Date().toISOString() }); });
    kill.on('error', () => { resolve({ exitCode: 0, exitedAt: new Date().toISOString() }); });
  });
}

export async function listAgySessions() {
  const sessions = [];
  try {
    const files = readdirSync(LOG_BASE).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const metaPath = join(LOG_BASE, file);
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      sessions.push(meta);
    }
  } catch (e) {
    console.warn(`Failed to list sessions: ${e.message}`);
  }
  return sessions;
}

export async function getAgyLog(sessionId, { tail = 100 } = {}) {
  const logPath = join(LOG_BASE, `${sessionId}.log`);
  if (!existsSync(logPath)) return '';
  try {
    const content = readFileSync(logPath, 'utf8');
    return content.split('\n').slice(-tail).join('\n');
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'spawn') {
    const [prompt, repoPath, model, agent, continueId] = args;
    spawnAgyPersistent({ prompt, repoPath, model, agent, continueId })
      .then(r => console.log(JSON.stringify(r, null, 2)))
      .catch(e => { console.error('Error:', e.message); process.exit(1); });
  } else if (cmd === 'stop') {
    stopAgyPersistent({ tmuxSessionName: args[0] })
      .then(r => console.log(JSON.stringify(r, null, 2)))
      .catch(e => { console.error('Error:', e.message); process.exit(1); });
  } else if (cmd === 'list') {
    listAgySessions().then(s => console.log(JSON.stringify(s, null, 2))).catch(e => { console.error('Error:', e.message); process.exit(1); });
  } else {
    console.log('Usage: agy-persistence.js spawn|stop|list [args]');
  }
}

if (isMainModule(import.meta.url)) main();

/**
 * CONCURRENCY MODEL (per Friday's autonomy rules):
 * - Max 1 concurrent agy session per account
 * - Sessions are bounded (spawn → run → exit or checkpoint)
 * - Resumable via --continue <conversationId>
 * - Never an infinite/eternal daemon
 *
 * Enforcement: Dispatcher (webhook) checks before calling spawnAgyPersistent
 * This wrapper is permissive; concurrency cap is enforced upstream
 */
