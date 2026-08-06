/**
 * Antigravity (agy) Harness Dispatcher
 *
 * Positional-arg adapter over agy-persistence.js (landed in #84) for Mission
 * Control's POST /run. Its whole job is shape translation: agy-persistence
 * speaks {conversationId, tmuxSessionName}, the session registry speaks
 * {sessionId, tmuxSession}.
 *
 * No fallback here, on purpose. This used to degrade to a blocking one-shot
 * `agy -p` on any failure, which resolved with a truthy sessionId and no pid —
 * so webhook-server recorded status=running with pid=null, and
 * reapDeadAgySessions() skips pid-less sessions, so the max-1-concurrent-agy cap
 * 409'd every later Antigravity dispatch for the life of the server. Throwing
 * instead lets the caller's catch exitSession() the record and free the cap.
 * tmux being unavailable already has a real fallback one layer down
 * (agy-persistence's spawnDirect), and that one returns a live pid.
 *
 * --dangerously-skip-permissions is deliberately not set here. It is opt-in via
 * AGY_ALLOW_DANGEROUS_SKIP_PERMISSIONS in agy-persistence.js. MC dispatches are
 * remote and unattended, so widening that default needs its own issue with
 * per-repo opt-in and a per-dispatch audit-log entry (see #203).
 */

import { spawnAgyPersistent as spawnAgyPersistentImpl } from './agy-persistence.js';

/**
 * Spawn a persistent agy session.
 *
 * @param {string} prompt - Task description
 * @param {string} repoPath - Absolute path to repo (pre-validated by repo-validator)
 * @param {string} [model] - Model override
 * @param {string} [agent] - Agent from the synced roster; omitted means agy's default
 * @param {string} [continueId] - Resume a previous agy conversation
 * @returns {Promise<{sessionId: string, tmuxSession: string|null, pid: number, logPath: string, status: string}>}
 * @throws if the harness could not be reached, or came back without a pid
 */
export async function spawnAgyPersistent(prompt, repoPath, model = null, agent = null, continueId = null) {
  const result = await spawnAgyPersistentImpl({ prompt, repoPath, model, agent, continueId });

  // Without a pid nothing can reap or stop the session, and the registry entry
  // wedges the concurrency cap. Loud beats leaked.
  if (!result.pid) throw new Error('agy harness returned no pid; session would be unreapable');

  return {
    sessionId: result.conversationId,
    tmuxSession: result.tmuxSessionName,
    pid: result.pid,
    logPath: result.logPath,
    status: 'running',
  };
}

export default { spawnAgyPersistent };
