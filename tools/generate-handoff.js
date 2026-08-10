#!/usr/bin/env node
/**
 * generate-handoff.js — Auto-generate HANDOFF.md for session continuation.
 *
 * Usage:
 *   node generate-handoff.js [--cwd=PATH] [--trigger=manual|auto]
 *
 * Writes HANDOFF.md at git repo root (or cwd if not a git repo).
 * Content: repo status, recent commits, current branch, open PR info, session context.
 * Deterministic, no LLM calls, no external API dependencies (except gh if available).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { isMainModule } from './is-main.js';
import { homedir } from 'node:os';
import { cwdToProjectDir } from './session-namer.js';

const args = process.argv.slice(2);
const flags = {};
for (const arg of args) {
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    if (eq >= 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    else flags[arg.slice(2)] = true;
  }
}

const CWD = flags.cwd || process.cwd();
const HOME = homedir();
const REGISTRY = join(HOME, 'agent-memory', 'nexus', 'session-registry.jsonl');

/**
 * Get git root directory. Returns null if not a git repo.
 */
function getGitRoot(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString().trim();
  } catch {
    return null;
  }
}

/**
 * Get current branch name.
 */
function getBranch(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString().trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Get git status --short output.
 */
function getGitStatus(cwd) {
  try {
    const out = execFileSync('git', ['status', '--short'], {
      cwd,
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString().trim();
  } catch {
    return '';
  }
}

/**
 * Get recent commits (10 lines).
 */
function getRecentCommits(cwd) {
  try {
    const out = execFileSync('git', ['log', '--oneline', '-10'], {
      cwd,
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString().trim();
  } catch {
    return '';
  }
}

/**
 * Get current PR info if available (via gh pr view).
 */
function getPRInfo(cwd) {
  try {
    const out = execFileSync('gh', ['pr', 'view', '--json', 'number,title,url,state'], {
      cwd,
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const data = JSON.parse(out.toString());
    return data;
  } catch {
    return null;
  }
}

/**
 * Get diff stat vs main (issue #166 enrichment). Best-effort: tries "main"
 * then "master"; returns '' if neither exists or the diff fails/is empty.
 */
function getDiffStatVsMain(cwd) {
  for (const base of ['main', 'master']) {
    try {
      const out = execFileSync('git', ['diff', '--stat', `${base}...HEAD`], {
        cwd, timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim();
      if (out) return out;
    } catch { /* try next base, or give up below */ }
  }
  return '';
}

/**
 * List open PRs and issues assigned to the current gh user (best-effort,
 * short timeout so a slow/offline `gh` never blocks handoff generation).
 */
function getAssignedGhItems(cwd) {
  const result = { prs: [], issues: [] };
  try {
    const out = execFileSync('gh', ['pr', 'list', '--assignee', '@me', '--state', 'open',
      '--json', 'number,title,url', '--limit', '10'], {
      cwd, timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    result.prs = JSON.parse(out.toString());
  } catch { /* gh unavailable, not authenticated, or no remote — skip silently */ }
  try {
    const out = execFileSync('gh', ['issue', 'list', '--assignee', '@me', '--state', 'open',
      '--json', 'number,title,url', '--limit', '10'], {
      cwd, timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    result.issues = JSON.parse(out.toString());
  } catch { /* skip silently */ }
  return result;
}

/**
 * Best-effort resume command for the current session, mirroring
 * session-namer.js's --resume output. Returns null if the transcript can't
 * be located (e.g. no session registered yet for this cwd).
 */
function getResumeCommand(sessionInfo) {
  if (!sessionInfo || !sessionInfo.session || !sessionInfo.cwd) return null;
  try {
    const projectDirName = cwdToProjectDir(sessionInfo.cwd);
    const transcript = join(homedir(), '.claude', 'projects', projectDirName, `${sessionInfo.session}.jsonl`);
    if (!existsSync(transcript)) return null;
    return `claude --continue "${transcript}"`;
  } catch {
    return null;
  }
}

/**
 * Get repo name from path (basename).
 */
function getRepoName(path) {
  const base = path.split(/[/\\]/).pop();
  return base || 'repo';
}

/**
 * Get current session info from registry (latest session in this cwd).
 */
function getCurrentSessionInfo(cwd) {
  if (!existsSync(REGISTRY)) return null;
  try {
    const lines = readFileSync(REGISTRY, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    // Find the most recent session in this cwd
    const matching = lines.filter(e => e.cwd === cwd).sort((a, b) =>
      (b.timestamp || '').localeCompare(a.timestamp || '')
    );

    return matching[0] || null;
  } catch {
    return null;
  }
}

const DEFAULT_NEXT_STEPS = `<!-- Add continuation notes here -->\n- [ ] \n`;

/**
 * Preserve any manually-written "Next Steps" content across regenerations.
 * Without this, every PreCompact (can fire many times in one long session)
 * or SessionEnd would silently wipe out notes a prior agent/user left for
 * the next session — defeating the entire point of a handoff doc.
 * Returns the existing section body, or null if there is none / it's still
 * just the untouched placeholder (in which case the caller uses the default).
 */
function readExistingNextSteps(handoffPath) {
  if (!existsSync(handoffPath)) return null;
  try {
    const prev = readFileSync(handoffPath, 'utf8');
    const marker = '## Next Steps\n\n';
    const idx = prev.indexOf(marker);
    if (idx === -1) return null;
    const body = prev.slice(idx + marker.length).trim();
    if (!body || body === DEFAULT_NEXT_STEPS.trim()) return null;
    return body;
  } catch {
    return null;
  }
}

/**
 * Generate HANDOFF.md content.
 */
function generateContent(gitRoot, cwd, existingNextSteps) {
  const repoName = getRepoName(gitRoot || cwd);
  const branch = getBranch(gitRoot || cwd);
  const gitStatus = getGitStatus(gitRoot || cwd);
  const recentCommits = getRecentCommits(gitRoot || cwd);
  const prInfo = getPRInfo(gitRoot || cwd);
  const sessionInfo = getCurrentSessionInfo(cwd);
  const diffStat = getDiffStatVsMain(gitRoot || cwd);
  const assigned = getAssignedGhItems(gitRoot || cwd);
  const resumeCmd = getResumeCommand(sessionInfo);

  const date = new Date().toISOString().slice(0, 10);
  const time = new Date().toISOString().slice(11, 16);

  let content = `# HANDOFF.md — ${repoName} Session Continuation\n\n`;
  content += `**Generated:** ${date} ${time}\n`;
  content += `**Branch:** ${branch}\n`;
  content += `**Repo:** ${repoName} (${cwd})\n\n`;
  content += `---\n\n`;

  // Session info
  if (sessionInfo) {
    content += `## Current Session\n\n`;
    content += `**Session ID:** ${sessionInfo.session}\n`;
    content += `**Title:** ${sessionInfo.title || 'pending'}\n`;
    if (sessionInfo.first_prompt) {
      content += `**First Prompt:** ${sessionInfo.first_prompt.slice(0, 150)}\n`;
    }
    content += `\n`;
  }

  // Repo status
  if (gitStatus) {
    content += `## Working Tree Status\n\n`;
    content += `⚠️  **Uncommitted work present** — commit or stash before ending the session.\n\n`;
    content += `\`\`\`\n${gitStatus}\n\`\`\`\n\n`;
  } else {
    content += `## Working Tree Status\n\n`;
    content += `Clean working tree.\n\n`;
  }

  // Recent commits
  if (recentCommits) {
    content += `## Recent Commits\n\n`;
    content += `\`\`\`\n${recentCommits}\n\`\`\`\n\n`;
  }

  // Diff stat vs main (issue #166)
  if (diffStat) {
    content += `## Diff vs main\n\n`;
    content += `\`\`\`\n${diffStat}\n\`\`\`\n\n`;
  }

  // PR info
  if (prInfo) {
    content += `## Pull Request\n\n`;
    content += `**PR #${prInfo.number}:** ${prInfo.title}\n`;
    content += `**State:** ${prInfo.state}\n`;
    content += `**URL:** ${prInfo.url}\n\n`;
  }

  // Assigned PRs/issues (issue #166, best-effort via gh)
  if (assigned.prs.length || assigned.issues.length) {
    content += `## Assigned to You (open)\n\n`;
    for (const pr of assigned.prs) content += `- PR #${pr.number}: ${pr.title} — ${pr.url}\n`;
    for (const iss of assigned.issues) content += `- Issue #${iss.number}: ${iss.title} — ${iss.url}\n`;
    content += `\n`;
  }

  // Resume command (issue #166)
  if (resumeCmd) {
    content += `## Resume\n\n`;
    content += `\`\`\`\n${resumeCmd}\n\`\`\`\n\n`;
  }

  // Next steps — preserve whatever a prior session left here; only fall
  // back to the placeholder for a brand-new handoff doc.
  content += `## Next Steps\n\n`;
  content += existingNextSteps ? `${existingNextSteps}\n` : DEFAULT_NEXT_STEPS;

  return content;
}

/**
 * Main entry point.
 */
function main() {
  const gitRoot = getGitRoot(CWD);
  const targetDir = gitRoot || CWD;
  const handoffPath = join(targetDir, 'HANDOFF.md');

  try {
    const existingNextSteps = readExistingNextSteps(handoffPath);
    const content = generateContent(gitRoot, CWD, existingNextSteps);
    writeFileSync(handoffPath, content, 'utf8');
    console.log(`[generate-handoff] wrote ${handoffPath}`);
  } catch (err) {
    console.error(`[generate-handoff] error: ${err.message}`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) main();
