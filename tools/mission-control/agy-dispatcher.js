#!/usr/bin/env node
/**
 * Antigravity (agy) Harness Dispatcher
 * Spawns one-shot and persistent agy sessions for Mission Control
 *
 * PERSISTENCE WRAPPER:
 * Leo is building tools/mission-control/agy-persistence.js (issue #84)
 * that provides spawnAgyPersistent({ prompt, repoPath, model?, continueId? })
 * This module stubs against that interface until it's available.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawnAgyPersistent as spawnAgyPersistentImpl } from './agy-persistence.js';

const HOME = homedir();
const AGY_CLI = 'agy'; // Assume agy is in PATH

/**
 * Spawn one-shot agy session
 * Uses direct `agy` CLI invocation, output captured to caller
 *
 * @param {string} prompt - Task description
 * @param {string} repoPath - Absolute path to repo (pre-validated)
 * @param {string} [model] - Model override (e.g., 'gemini-2.0')
 * @returns {Promise<{sessionId: string, logPath: null, status: string}>}
 *   sessionId: auto-assigned from history.jsonl
 *   logPath: null (agy manages its own history)
 *   status: 'running' (agy runs one-shot)
 */
export async function spawnAgyOneShotDirect(prompt, repoPath, model = null, agent = null) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--add-dir', repoPath];
    if (model) args.push('--model', model);
    if (agent) args.push('--agent', agent);

    // TODO: Add --dangerously-skip-permissions for MC context (requires confirmation)
    // args.push('--dangerously-skip-permissions');

    const child = spawn(AGY_CLI, args, {
      cwd: repoPath,
      env: { ...process.env, HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '', stderr = '';
    child.stdout?.on('data', d => (stdout += d));
    child.stderr?.on('data', d => (stderr += d));

    child.on('close', (code) => {
      resolve({
        sessionId: null, // agy doesn't expose session IDs from one-shot
        logPath: null,
        status: code === 0 ? 'exited' : 'failed',
        exitCode: code,
        output: stdout + stderr,
      });
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn agy: ${err.message}`));
    });

    // Timeout after 30 minutes (agy may run long for some tasks)
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('agy spawn timeout (30m)'));
    }, 30 * 60 * 1000);

    child.on('close', () => clearTimeout(timeout));
  });
}

/**
 * Spawn persistent agy session (wraps Leo's agy-persistence.js)
 * This function stubs against Leo's module until #84 is merged
 *
 * @param {string} prompt - Task description
 * @param {string} repoPath - Absolute path to repo (pre-validated)
 * @param {string} [model] - Model override
 * @param {string} [continueId] - Resume from previous conversation
 * @returns {Promise<{sessionId: string, tmuxSession: string, logPath: string, status: string}>}
 */
export async function spawnAgyPersistent(prompt, repoPath, model = null, agent = null, continueId = null) {
  try {
    const result = await spawnAgyPersistentImpl({ prompt, repoPath, model, agent, continueId });
    return {
      sessionId: result.conversationId,
      tmuxSession: result.tmuxSessionName,
      pid: result.pid,
      logPath: result.logPath,
      status: 'running',
    };
  } catch (e) {
    console.warn('[agy-dispatcher] spawnAgyPersistent failed, falling back to one-shot:', e.message);
    const result = await spawnAgyOneShotDirect(prompt, repoPath, model, agent);
    return {
      sessionId: continueId || 'agy-oneShotFallback',
      tmuxSession: null,
      logPath: null,
      status: result.status,
      exitCode: result.exitCode,
    };
  }
}

export default { spawnAgyOneShotDirect, spawnAgyPersistent };
