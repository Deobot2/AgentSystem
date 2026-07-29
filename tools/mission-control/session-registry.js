#!/usr/bin/env node
/**
 * Mission Control Session Registry
 * Persistent store for all spawned sessions (claude + agy)
 * File: ~/.claude/mission-control-registry.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export class SessionRegistry {
  /**
   * @param {string} registryPath - Path to registry JSON file (default: ~/.claude/mission-control-registry.json)
   */
  constructor(registryPath = null) {
    this.registryPath = registryPath || `${process.env.HOME || process.env.USERPROFILE}/.claude/mission-control-registry.json`;
    this.sessions = this._loadRegistry();
  }

  _loadRegistry() {
    try {
      if (existsSync(this.registryPath)) {
        const content = readFileSync(this.registryPath, 'utf8');
        const data = JSON.parse(content);
        return data.sessions || [];
      }
    } catch (e) {
      console.warn(`Failed to load registry ${this.registryPath}:`, e.message);
    }
    return [];
  }

  _saveRegistry() {
    try {
      const dir = dirname(this.registryPath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(this.registryPath, JSON.stringify({ sessions: this.sessions }, null, 2));
    } catch (e) {
      console.error(`Failed to save registry ${this.registryPath}:`, e.message);
    }
  }

  /**
   * Generate short random hex ID
   * @returns {string} 8-character hex string
   */
  _generateShortId() {
    return randomBytes(4).toString('hex');
  }

  /**
   * Create a new session entry
   * @param {object} opts - Session options
   * @param {string} opts.harness - 'claude' or 'agy'
   * @param {string} opts.repo - Repo slug
   * @param {string} opts.prompt - Task prompt
   * @param {string} [opts.agent] - Agent name (both harnesses; optional for agy)
   * @param {string} [opts.model] - Model override (for agy)
   * @returns {object} Created session
   */
  createSession(opts) {
    const {
      harness,
      repo,
      prompt,
      agent = null,
      model = null,
    } = opts;

    if (!harness || !['claude', 'agy'].includes(harness)) {
      throw new Error(`Invalid harness: ${harness}`);
    }
    if (!repo) throw new Error('repo required');
    if (!prompt) throw new Error('prompt required');

    const id = `${harness}-${this._generateShortId()}`;
    const now = new Date().toISOString();

    const session = {
      id,
      // Both harnesses run the same agent roster (synced by tools/sync-agents.js),
      // so an agy session keeps its agent too — nulling it here is what made
      // Antigravity sessions render as a nameless "Antigravity" row in the panel.
      agent,
      harness,
      model: harness === 'agy' ? model : null,
      repo,
      prompt,
      spawnedAt: now,
      exitedAt: null,
      status: 'spawning',
      logPath: null,
      costEstimate: null,
      exitCode: null,
    };

    this.sessions.push(session);
    this._saveRegistry();

    return session;
  }

  /**
   * Get a session by ID
   * @param {string} id - Session ID
   * @returns {object|null} Session or null if not found
   */
  getSession(id) {
    return this.sessions.find(s => s.id === id) || null;
  }

  /**
   * Update session fields
   * @param {string} id - Session ID
   * @param {object} updates - Fields to update
   */
  updateSession(id, updates) {
    const session = this.getSession(id);
    if (!session) throw new Error(`Session ${id} not found`);

    Object.assign(session, updates);
    this._saveRegistry();

    return session;
  }

  /**
   * Mark session as exited
   * @param {string} id - Session ID
   * @param {number} exitCode - Exit code
   * @param {string} [logPath] - Final log path
   */
  exitSession(id, exitCode, logPath = null) {
    return this.updateSession(id, {
      status: 'exited',
      exitedAt: new Date().toISOString(),
      exitCode,
      logPath: logPath || this.getSession(id).logPath,
    });
  }

  /**
   * Get all sessions
   * @returns {array} All sessions
   */
  getSessions() {
    return [...this.sessions];
  }

  /**
   * Get active sessions (spawning or running)
   * Used for concurrency cap enforcement: includes both spawning and running
   * @returns {array} Sessions with status=spawning or running
   */
  getRunning() {
    return this.sessions.filter(s => ['spawning', 'running'].includes(s.status));
  }

  /**
   * Get sessions from past 24h
   * @returns {array} Recent sessions
   */
  getRecent() {
    const oneDayAgo = new Date(Date.now() - 86400_000);
    return this.sessions.filter(s => new Date(s.spawnedAt) >= oneDayAgo);
  }
}

export default SessionRegistry;
