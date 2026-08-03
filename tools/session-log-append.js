#!/usr/bin/env node
/**
 * session-log-append.js — append session summary to ~/agent-memory/nexus/session-log.jsonl
 * with deduplication (don't log the same session twice).
 *
 * Called from SessionEnd/Stop hook to record a durable summary of session work.
 * Tracks: session id, repo, cwd, title, outcome, uncommitted changes, orphaned branches.
 *
 * Usage:
 *   node session-log-append.js --session=ID --repo=NAME --title=TEXT [--cwd=PATH] [--outcome=OUTCOME]
 *
 * No npm deps — Node.js builtins + basic git commands only.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { isMainModule } from './is-main.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function getHome() {
  return process.env.SESSION_LOG_HOME || homedir();
}

function getSessionLogPath() {
  const HOME = getHome();
  return join(HOME, 'agent-memory', 'nexus', 'session-log.jsonl');
}

function ensureLogDir() {
  const HOME = getHome();
  mkdirSync(join(HOME, 'agent-memory', 'nexus'), { recursive: true });
}

function loadExistingEntries() {
  ensureLogDir();
  const logPath = getSessionLogPath();
  if (!existsSync(logPath)) return new Map();

  const entries = new Map();
  try {
    const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.session) entries.set(obj.session, obj);
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // Log file doesn't exist or can't be read — start fresh
  }
  return entries;
}

function checkGitStatus(cwd) {
  if (!cwd) return { hasUncommitted: false, orphanedBranches: [] };

  try {
    // Check for uncommitted changes
    const statusOutput = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const hasUncommitted = statusOutput.trim().length > 0;

    // Check for orphaned branches (branches with no upstream or commits ahead of main)
    let orphanedBranches = [];
    try {
      const branchOutput = execFileSync('git', ['branch', '-vv'], {
        cwd,
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const lines = branchOutput.split('\n').filter(l => l.trim());
      for (const line of lines) {
        // Lines like: "  branch-name  abc1234 [origin/main: ahead 5] commit message"
        // or:        "  branch-name  abc1234 commit message" (no upstream)
        const trimmed = line.replace(/^\*\s+/, '').trim();
        if (!trimmed) continue;

        const parts = trimmed.split(/\s+/);
        if (parts.length < 2) continue;

        const branchName = parts[0];
        // Skip if it's the current branch or main
        if (line.startsWith('*') || branchName === 'main' || branchName === 'master') continue;

        // Check if it has no upstream (third column would be the commit hash, not [origin/...])
        const hasUpstream = trimmed.includes('[origin/');
        if (!hasUpstream) {
          orphanedBranches.push(branchName);
        }
      }
    } catch {
      // branch -vv failed — leave orphanedBranches empty
    }

    return { hasUncommitted, orphanedBranches };
  } catch {
    return { hasUncommitted: false, orphanedBranches: [] };
  }
}

function buildSessionSummary({ sessionId, repo, title, cwd, outcome, timestamp }) {
  const ts = timestamp || new Date().toISOString();
  const gitStatus = checkGitStatus(cwd);

  return {
    session: sessionId,
    repo,
    title: title || 'untitled',
    cwd: cwd || '',
    outcome: outcome || 'unknown',
    timestamp: ts,
    hasUncommitted: gitStatus.hasUncommitted,
    orphanedBranches: gitStatus.orphanedBranches,
  };
}

function appendSessionLog(summary) {
  ensureLogDir();

  // Load existing entries and check for duplicates
  const existing = loadExistingEntries();
  if (existing.has(summary.session)) {
    // Already logged — don't double-log
    console.log(`[session-log] ${summary.session.slice(0, 8)}… already logged, skipping`);
    return;
  }

  // Append the new entry
  try {
    const logPath = getSessionLogPath();
    appendFileSync(logPath, JSON.stringify(summary) + '\n', 'utf8');
    console.log(`[session-log] ${summary.session.slice(0, 8)}… → "${summary.title}" (${summary.outcome})`);
  } catch (err) {
    console.error(`[session-log] failed to append: ${err.message}`);
    process.exit(1);
  }
}

// ── Arg parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {};
for (const arg of args) {
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    if (eq >= 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    else flags[arg.slice(2)] = true;
  }
}

// Only auto-run the CLI when this file is executed directly.
const isMain = isMainModule(import.meta.url);
if (isMain) {
  const { session, repo, title, cwd, outcome, timestamp } = flags;

  if (!session || !repo) {
    console.error('--session and --repo required');
    process.exit(1);
  }

  const summary = buildSessionSummary({ sessionId: session, repo, title, cwd, outcome, timestamp });
  appendSessionLog(summary);
}
