#!/usr/bin/env node
/**
 * pm-hygiene.js — Session completion hygiene checks & documentation.
 *
 * Runs on SessionEnd/Stop hook to:
 * 1. Create/update HANDOFF.md if work is unfinished (uncommitted changes, branches)
 * 2. Append one-line session summary to ~/agent-memory/nexus/session-log.jsonl (deduped)
 * 3. Flag uncommitted changes and orphaned branches
 * 4. Optionally verify any opened PR passed pr-guard checks
 *
 * Usage:
 *   node pm-hygiene.js --session=ID --cwd=PATH [--transcript-path=PATH]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { isMainModule } from './is-main.js';

const HOME = homedir();
// #351 test hook: allow tests to point this at a temp file instead of the real, shared
// ~/agent-memory/nexus/session-log.jsonl (CLAUDE.md: never write to ~/agent-memory outside
// documented tools/paths — this override keeps tests off the real file entirely).
const SESSION_LOG = process.env.AGENT_SESSION_LOG || join(HOME, 'agent-memory', 'nexus', 'session-log.jsonl');

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function safeExec(cmd, args, opts = {}) {
  try {
    const result = execFileSync(cmd, args, {
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    return result.toString().trim();
  } catch {
    return null;
  }
}

/**
 * Check for uncommitted changes in the given cwd.
 * Returns { hasChanges: boolean, status: string (first line of git status) }
 */
function checkUncommittedChanges(cwd) {
  const status = safeExec('git', ['status', '--porcelain'], { cwd });
  if (!status) return { hasChanges: false, status: '' };
  const lines = status.split('\n').filter(Boolean);
  return { hasChanges: lines.length > 0, status: lines[0] };
}

/**
 * Get current branch name.
 * Returns null if not in a git repo or on detached HEAD.
 */
function getCurrentBranch(cwd) {
  return safeExec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
}

/**
 * Find orphaned branches (branches with no upstream or commits ahead of main).
 * Returns array of branch names.
 */
function findOrphanedBranches(cwd) {
  const branches = safeExec('git', ['branch', '--format=%(refname:short)'], { cwd });
  if (!branches) return [];

  const orphaned = [];
  for (const branch of branches.split('\n').filter(Boolean)) {
    if (branch === 'main' || branch === 'master' || branch === 'HEAD') continue;

    // Check if branch has an upstream
    const hasUpstream = safeExec('git', ['rev-parse', '--abbrev-ref', `${branch}@{u}`], { cwd });
    if (!hasUpstream) {
      orphaned.push(branch);
      continue;
    }

    // Check if branch is ahead of main
    const ahead = safeExec(
      'git',
      ['rev-list', '--count', 'main..HEAD'],
      { cwd, env: { ...process.env, GIT_BRANCH: branch } }
    );
    if (ahead === '0') orphaned.push(branch);
  }

  return orphaned;
}

/**
 * Extract PR number from session registry if a PR was opened.
 * Returns PR number as string or null.
 */
function getPRFromRegistry(sessionId) {
  const registryPath = join(HOME, 'agent-memory', 'nexus', 'session-registry.jsonl');
  if (!existsSync(registryPath)) return null;

  try {
    const lines = readFileSync(registryPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.session === sessionId && entry.issue) {
        return entry.issue;
      }
    }
  } catch {
    // Ignore parse errors
  }

  return null;
}

/**
 * Check if a PR passed pr-guard by querying the pr-results file.
 * Returns { passed: boolean, prNumber: string, details: string }
 */
function checkPRGuard(prNumber, sessionId) {
  if (!prNumber) return { passed: false, prNumber: null, details: 'No PR number found' };

  // Try to find pr-guard results in session logs or memory
  const prResultsPath = join(HOME, 'agent-memory', 'nexus', `pr-guard-${prNumber}.json`);
  if (existsSync(prResultsPath)) {
    try {
      const data = JSON.parse(readFileSync(prResultsPath, 'utf8'));
      return { passed: data.passed === true, prNumber, details: data.status || 'Unknown' };
    } catch {
      return { passed: false, prNumber, details: 'Could not parse pr-guard results' };
    }
  }

  return { passed: false, prNumber, details: 'pr-guard results not found (run `node tools/pr-guard.js <pr>`)'};
}

/**
 * Build a HANDOFF.md file content for unfinished work.
 */
function buildHandoffMarkdown(sessionId, cwd, uncommitted, orphaned, prInfo) {
  const timestamp = new Date().toISOString();
  const branch = getCurrentBranch(cwd) || 'unknown';

  let content = `# Session Handoff — ${timestamp}

**Session ID:** \`${sessionId}\`
**Branch:** \`${branch}\`
**CWD:** \`${cwd}\`

## Status

`;

  if (uncommitted.hasChanges) {
    content += `### Uncommitted Changes ⚠️
\`\`\`
${uncommitted.status}
\`\`\`

**Action:** Run \`git add\` and \`git commit\` or \`git stash\` to clean the working tree.

`;
  }

  if (orphaned.length > 0) {
    content += `### Orphaned Branches 🌿
${orphaned.map(b => `- \`${b}\``).join('\n')}

**Action:** Delete with \`git branch -d <branch>\` or push upstream.

`;
  }

  if (prInfo.prNumber) {
    const status = prInfo.passed ? '✅ PASSED' : '❌ NEEDS REVIEW';
    content += `### PR Status
- **PR #${prInfo.prNumber}:** ${status}
- **Details:** ${prInfo.details}

**Action:** ${prInfo.passed ? 'PR is ready for merge.' : 'Run `node tools/pr-guard.js ' + prInfo.prNumber + '` to verify all checks pass.'}

`;
  }

  content += `## Next Steps

1. Resolve any uncommitted changes
2. Clean up orphaned branches
3. Verify PR status if applicable
4. Resume or close the session

---
_Auto-generated by pm-hygiene.js on session close._
`;

  return content;
}

/**
 * Write or update HANDOFF.md if there is unfinished work.
 */
function writeHandoffMarkdown(sessionId, cwd, uncommitted, orphaned, prInfo) {
  const hasWork = uncommitted.hasChanges || orphaned.length > 0 || prInfo.prNumber;
  if (!hasWork) return; // No unfinished work, skip

  const handoffPath = join(cwd, 'HANDOFF.md');
  const content = buildHandoffMarkdown(sessionId, cwd, uncommitted, orphaned, prInfo);
  writeFileSync(handoffPath, content, 'utf8');
  console.log(`[pm-hygiene] HANDOFF.md created at ${handoffPath}`);
}

/**
 * Load the session registry entry for a session.
 */
function loadSessionEntry(sessionId) {
  const registryPath = join(HOME, 'agent-memory', 'nexus', 'session-registry.jsonl');
  if (!existsSync(registryPath)) return null;

  try {
    const lines = readFileSync(registryPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.session === sessionId) return entry;
    }
  } catch {
    // Ignore parse errors
  }

  return null;
}

/**
 * Merge a one-line summary into session-log.jsonl, deduped by session_id.
 *
 * #351: this used to REPLACE any existing row for `sessionId` with a summary-only object
 * ({session, timestamp, summary, cwd}). session-end.sh appends the real cost row for the
 * same session ({ts, session, agent, cost_usd, in_tok, out_tok}) via session-cost-compute.js
 * moments earlier in the same Stop-hook invocation — so this function ran second and
 * silently deleted the cost/token fields on every single session, which is why 0/145 rows
 * in the #351 audit carried cost_usd/in_tok/out_tok. Fix: merge the summary fields onto the
 * existing row for this session instead of replacing it, so whichever writer ran first is
 * preserved.
 */
function appendSessionSummary(sessionId, summary, cwd) {
  ensureDir(SESSION_LOG);

  // Read existing entries
  let entries = [];
  if (existsSync(SESSION_LOG)) {
    try {
      entries = readFileSync(SESSION_LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch {
      entries = [];
    }
  }

  const patch = {
    session: sessionId,
    timestamp: new Date().toISOString(),
    summary: summary.slice(0, 200), // Truncate to 200 chars
    cwd: cwd || '',
  };

  const idx = entries.findIndex(e => e.session === sessionId);
  if (idx >= 0) {
    // Merge onto the existing row — preserves ts/cost_usd/in_tok/out_tok/agent if
    // session-end.sh already wrote them for this session.
    entries[idx] = { ...entries[idx], ...patch };
  } else {
    entries.push(patch);
  }

  // Write back
  writeFileSync(
    SESSION_LOG,
    entries.map(e => JSON.stringify(e)).join('\n') + '\n',
    'utf8'
  );
  console.log(`[pm-hygiene] session summary appended to ${SESSION_LOG}`);
}

/**
 * Main command: run full PM hygiene check and output summary.
 */
async function cmdRunHygiene({ session, cwd, transcriptPath }) {
  if (!session) {
    console.error('--session required');
    process.exit(1);
  }

  if (!cwd) cwd = process.cwd();

  // Check for uncommitted changes
  const uncommitted = checkUncommittedChanges(cwd);

  // Find orphaned branches
  const orphaned = findOrphanedBranches(cwd);

  // Check PR status
  const prNumber = getPRFromRegistry(session);
  const prInfo = checkPRGuard(prNumber, session);

  // Load session entry for title
  const sessionEntry = loadSessionEntry(session) || {};
  const sessionTitle = sessionEntry.title || sessionEntry.name || 'unnamed';

  // Write HANDOFF.md if there is unfinished work
  writeHandoffMarkdown(session, cwd, uncommitted, orphaned, prInfo);

  // Build summary line
  const flags = [];
  if (uncommitted.hasChanges) flags.push('uncommitted');
  if (orphaned.length > 0) flags.push(`${orphaned.length}-orphaned`);
  if (prNumber && !prInfo.passed) flags.push('pr-needs-guard');

  const summary = `${sessionTitle} [${flags.length > 0 ? flags.join(',') : 'clean'}]`;

  // Append to session log
  appendSessionSummary(session, summary, cwd);

  // Output for human readability
  console.log(`[pm-hygiene] session=${session.slice(0, 8)}… clean=${!flags.length}`);
  if (uncommitted.hasChanges) console.log(`[pm-hygiene]   uncommitted: ${uncommitted.status}`);
  if (orphaned.length > 0) console.log(`[pm-hygiene]   orphaned: ${orphaned.join(', ')}`);
  if (prNumber) console.log(`[pm-hygiene]   PR #${prNumber} guard=${prInfo.passed ? 'passed' : 'NEEDS RUN'}`);
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

if (isMainModule(import.meta.url)) {
  cmdRunHygiene({
    session: flags.session,
    cwd: flags.cwd,
    transcriptPath: flags['transcript-path'],
  }).catch(err => {
    console.error('[pm-hygiene] error:', err.message);
    process.exit(1);
  });
}

export { appendSessionSummary, SESSION_LOG };
