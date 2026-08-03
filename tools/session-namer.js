#!/usr/bin/env node
/**
 * session-namer.js — Auto-name, search, group, and resume Claude Code sessions.
 *
 * Legacy display name format: <repo> - <5-word title> - <YYYY-MM-DD HH:mm> [+ (done)]
 * Deterministic status-lifecycle fields (issue #158, additive — zero AI calls):
 *   status:     started | pr | done   (never regresses)
 *   slug:       branch name minus "issue-N-" prefix (or first 4 words of title)
 *   statusName: `<repo> - <slug> - <YYMMDD-HHmm> - <status>`
 * Registry: ~/agent-memory/nexus/session-registry.jsonl
 *
 * Usage:
 *   node session-namer.js --register --session=ID [--cwd=PATH]
 *   node session-namer.js --finalize --session=ID
 *   node session-namer.js --sweep                 Retroactively finalize all pending sessions with transcripts
 *   node session-namer.js --scan
 *   node session-namer.js --list [--repo=NAME] [--date=YYYY-MM-DD] [--limit=N]
 *   node session-namer.js --search QUERY
 *   node session-namer.js --group [--by=repo|date]
 *   node session-namer.js --resume SESSION_ID
 *   node session-namer.js --today
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, createReadStream } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { isMainModule } from './is-main.js';

const HOME         = process.env.SESSION_NAMER_HOME || homedir();
const REGISTRY     = join(HOME, 'agent-memory', 'nexus', 'session-registry.jsonl');
const PROJECTS_DIR = join(HOME, '.claude', 'projects');

// Stop words stripped when building the 5-word title
const STOP_WORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being',
  'in','on','at','to','for','of','and','or','but','with','from',
  'how','what','why','when','where','which','who',
  'please','can','could','would','should','will','do','did','does',
  'i','you','we','me','my','your','our','it','its',
  'this','that','these','those','just','really','very','also',
  'need','want','make','get','use','have','has','had','let',
  'help','add','fix','run','new','old','up','out','so','then',
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureRegistry() {
  mkdirSync(join(HOME, 'agent-memory', 'nexus'), { recursive: true });
  if (!existsSync(REGISTRY)) writeFileSync(REGISTRY, '', 'utf8');
}

function loadRegistry() {
  ensureRegistry();
  return readFileSync(REGISTRY, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function saveEntry(entry) {
  ensureRegistry();
  const lines = readFileSync(REGISTRY, 'utf8').split('\n').filter(Boolean);
  const idx   = lines.findIndex(l => {
    try { return JSON.parse(l).session === entry.session; } catch { return false; }
  });
  if (idx >= 0) lines[idx] = JSON.stringify(entry);
  else lines.push(JSON.stringify(entry));
  writeFileSync(REGISTRY, lines.join('\n') + '\n', 'utf8');
}

/** /home/natha/dev/AgentSystem → agentsystem */
function repoFromCwd(cwd) {
  if (!cwd) return 'unknown';
  const base = basename(cwd).replace(/^\./, '').toLowerCase();
  return base || 'root';
}

/** cwd -> Claude Code project dir name.
 *  Proven against a live ~/.claude/projects listing: Claude Code replaces every
 *  character that is not [A-Za-z0-9] with a single '-' (no collapsing of runs).
 *  Example: "C:/Users/natha/dev/AgentSystem" -> "C--Users-natha-dev-AgentSystem".
 *  A worktree cwd like ".../AgentSystem/.claude/worktrees/foo" becomes
 *  "...AgentSystem--claude-worktrees-foo" -- note the "." before "claude" is
 *  ALSO replaced with a dash. The old regex only replaced slash/backslash/colon
 *  and missed '.', so every worktree session (which always has "/.claude/" in
 *  its cwd) produced a project dir name one dash short of the real one -- a
 *  silent lookup miss that hit worktree sessions hardest. Backslash-style
 *  Windows paths normalize identically since backslash is non-alphanumeric too. */
export function cwdToProjectDir(cwd) {
  if (!cwd) return '';
  const resolved = resolve(cwd);
  return resolved.replace(/[^A-Za-z0-9]/g, '-');
}

/** Extract 7 significant words from free text (issue #166: raised from 5 to 7). */
function titleFromText(text) {
  if (!text || typeof text !== 'string') return 'untitled session';
  const words = text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, '')   // strip code fences
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
  return words.slice(0, 7).join(' ') || 'untitled session';
}

function dateStr(ts) { return (ts || new Date().toISOString()).slice(0, 10); }
function dateTimeStr(ts) { return (ts || new Date().toISOString()).slice(0, 16).replace('T', ' '); }
function today()     { return new Date().toISOString().slice(0, 10); }

/**
 * issueNumberFromBranch — extract N from a branch named "issue-N-*". Pure
 * string match, no AI. Returns null when the branch doesn't match.
 */
export function issueNumberFromBranch(branch) {
  if (!branch || typeof branch !== 'string') return null;
  const m = branch.match(/^issue-(\d+)-/);
  return m ? m[1] : null;
}

/**
 * buildName — end-of-session display name. Appends " [#N]" after the title
 * when the session's branch matches "issue-N-*" (issue #166).
 * Format: `<repo> - <title>[ [#N]] - <YYYY-MM-DD HH:mm>`
 */
function buildName(repo, title, ts, issueNum) {
  const suffix = issueNum ? ` [#${issueNum}]` : '';
  return `${repo} - ${title}${suffix} - ${dateTimeStr(ts)}`;
}

// ── Deterministic status-lifecycle naming (issue #158) ──────────────────────
// Fully precalculable: pure string/date ops, zero model/claude CLI calls.
// Format: `<repo> - <slug> - <YYMMDD-HHmm> - <status>`
// status lifecycle: started (SessionStart/register) -> pr (PR-create detected)
// -> done (SessionEnd/finalize-close). Never regresses (done is terminal).

/** Valid values for the deterministic status field, in lifecycle order. */
export const STATUS_LIFECYCLE = ['started', 'pr', 'done'];

/** YYMMDD-HHmm, e.g. 2026-07-06T14:05:00Z -> 260706-1405. Pure string slicing, no AI. */
export function formatStamp(ts) {
  const iso = ts || new Date().toISOString();
  const yy = iso.slice(2, 4), mo = iso.slice(5, 7), dd = iso.slice(8, 10);
  const hh = iso.slice(11, 13), mm = iso.slice(14, 16);
  return `${yy}${mo}${dd}-${hh}${mm}`;
}

/**
 * slug = branch name minus the "issue-N-" prefix, e.g. "issue-158-deterministic-automation"
 * -> "deterministic-automation". Falls back to the first 4 words of an existing
 * generated title (e.g. when renaming an already-named session, or no branch is
 * available) collapsed to a dash-slug. Pure string ops only.
 */
export function slugFromBranch(branch, fallbackTitle) {
  if (branch && typeof branch === 'string') {
    const stripped = branch.replace(/^issue-\d+-/, '').trim();
    if (stripped) return stripped.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
  }
  if (fallbackTitle && typeof fallbackTitle === 'string' && fallbackTitle !== 'pending') {
    const words = fallbackTitle.trim().split(/\s+/).slice(0, 4);
    if (words.length) return words.join('-').toLowerCase().replace(/[^a-z0-9-]/g, '');
  }
  return 'session';
}

/** Build the deterministic `<repo> - <slug> - <YYMMDD-HHmm> - <status>` name. */
export function buildStatusName(repo, slug, ts, status) {
  const s = STATUS_LIFECYCLE.includes(status) ? status : 'started';
  return `${repo} - ${slug} - ${formatStamp(ts)} - ${s}`;
}

/**
 * Never let status regress down the lifecycle (started -> pr -> done). "done"
 * is terminal. Pure lookup, no AI.
 */
function nextStatus(current, proposed) {
  const ci = STATUS_LIFECYCLE.indexOf(current);
  const pi = STATUS_LIFECYCLE.indexOf(proposed);
  if (pi < 0) return current || 'started';
  if (ci < 0) return proposed;
  return pi > ci ? proposed : current;
}

/** Marker appended to display name when a session is finalized. */
const DONE_MARKER = ' + (done)';

// Accept any human-originated first prompt, not just interactively "typed" ones.
// "queued" = the -p prompt of a `claude --bg --agent X -p "..."` spawn (Friday's mandatory
// delegation pattern spawns dozens of these daily -- they were ALL stuck un-renamed before
// this fix). "sdk" = SDK/API-driven sessions. Excludes "system"/"task-notification" origin,
// which are automated pings, not real prompts.
const HUMAN_PROMPT_SOURCES = new Set(['typed', 'queued', 'sdk']);

/**
 * Append DONE_MARKER to a session display name.
 * Idempotent: never double-appends.
 * Only marks a session "done" when it has a REAL title -- a still-"pending"
 * (unnamed) session must never be marked done (nothing to mark done).
 * Does NOT touch the title field -- title stays clean for search/grouping.
 */
function applyDoneMarker(name, title) {
  if (!name || !title || title === 'pending') return name;
  if (name.endsWith(DONE_MARKER)) return name;
  return name + DONE_MARKER;
}

/**
 * Strip DONE_MARKER from a name for matching/resume/rename purposes.
 * Keeps grouping and search working correctly on finalized entries.
 */
function stripDoneMarker(name) {
  if (!name) return name;
  return name.endsWith(DONE_MARKER) ? name.slice(0, -DONE_MARKER.length) : name;
}

// ── Read first user message from session JSONL ───────────────────────────────

async function readFirstUserMessage(sessionId, cwd) {
  let projectDir = null;

  if (cwd) {
    const candidate = join(PROJECTS_DIR, cwdToProjectDir(cwd));
    if (existsSync(candidate)) projectDir = candidate;
  }

  if (!projectDir) {
    for (const dir of readdirSync(PROJECTS_DIR)) {
      const f = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
      if (existsSync(f)) { projectDir = join(PROJECTS_DIR, dir); break; }
    }
  }

  if (!projectDir) return null;
  const filePath = join(projectDir, `${sessionId}.jsonl`);
  if (!existsSync(filePath)) return null;

  return new Promise(resolve => {
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    let found = null;
    rl.on('line', line => {
      if (found) return;
      try {
        const obj = JSON.parse(line);
        if (
          obj.type === 'user' &&
          (obj.origin?.kind === 'human' || HUMAN_PROMPT_SOURCES.has(obj.promptSource)) &&
          typeof obj.message?.content === 'string' &&
          obj.message.content.trim().length > 0
        ) {
          found = { text: obj.message.content.trim(), ts: obj.timestamp, cwd: obj.cwd };
          rl.close();
        }
      } catch { /* skip malformed lines */ }
    });
    rl.on('close', () => resolve(found));
    rl.on('error',  () => resolve(null));
  });
}

// ── Commands ─────────────────────────────────────────────────────────────────

function cmdRegister({ session, cwd }) {
  if (!session) { console.error('--session required'); process.exit(1); }

  // Resume fires SessionStart again for the same session_id. Never stomp an
  // existing entry back to "pending" -- that would destroy the real title
  // (and the " + (done)" marker) that --print-title needs to show on resume.
  const existing = loadRegistry().find(e => e.session === session);
  if (existing) {
    if (!existing.cwd && cwd) saveEntry({ ...existing, cwd });
    return;
  }

  const repo   = repoFromCwd(cwd);
  const ts     = new Date().toISOString();
  const branch = getGitBranch(cwd);
  const slug   = slugFromBranch(branch);
  const status = 'started';
  const entry = { session, repo, cwd: cwd || '', title: 'pending',
                  name: buildName(repo, 'pending', ts), timestamp: ts, finalized: false,
                  status, slug, statusName: buildStatusName(repo, slug, ts, status) };
  saveEntry(entry);
}

/**
 * cmdSetStatus — deterministic status-lifecycle transition (issue #158).
 * Called from a PostToolUse hook that detects a `gh pr create` invocation
 * (status -> "pr") and from SessionEnd (status -> "done"). Pure string/lookup
 * logic, zero model/claude CLI calls. Never regresses the lifecycle.
 */
function cmdSetStatus({ session, status }) {
  if (!session) { console.error('--session required'); process.exit(1); }
  if (!STATUS_LIFECYCLE.includes(status)) { console.error(`--status must be one of ${STATUS_LIFECYCLE.join('|')}`); process.exit(1); }
  const existing = loadRegistry().find(e => e.session === session);
  if (!existing) return; // not registered yet — nothing to update

  const repo   = existing.repo || 'unknown';
  const branch = getGitBranch(existing.cwd);
  const slug   = existing.slug || slugFromBranch(branch, existing.title);
  const newStatus = nextStatus(existing.status, status);
  const statusName = buildStatusName(repo, slug, existing.timestamp, newStatus);
  saveEntry({ ...existing, status: newStatus, slug, statusName });
  console.log(`[session-namer] ${session.slice(0, 8)}… status → "${newStatus}" ("${statusName}")`);
}

async function cmdFinalize({ session }) {
  if (!session) { console.error('--session required'); process.exit(1); }
  const existing = loadRegistry().find(e => e.session === session)
                || { session, repo: 'unknown', cwd: '' };

  // Idempotency: never clobber an already-named session (renamed or has a real title)
  if (existing.finalized && existing.title && existing.title !== 'pending') return;

  // Manually renamed but not yet finalized (e.g. renamed via /rename-session
  // while still "pending" mid-session) -- the session is ending now, so keep
  // the user's chosen title; do not overwrite it with a transcript-derived guess.
  // NOTE: --finalize does NOT apply the done marker. Only --finalize-close does.
  if (existing.renamed && existing.title && existing.title !== 'pending') {
    saveEntry({ ...existing, finalized: true });
    return;
  }

  const msg = await readFirstUserMessage(session, existing.cwd);
  if (!msg) {
    // Stop-hook path, no transcript yet (e.g. process killed before any user
    // message was written). There is no real title, so there is nothing to
    // mark "done" -- leave the entry as pending/unfinalized so the next
    // SessionStart sweep can finalize it once a transcript actually exists.
    return;
  }

  const title    = titleFromText(msg.text);
  const repo     = existing.repo !== 'unknown' ? existing.repo : repoFromCwd(msg.cwd);
  const branch   = getGitBranch(msg.cwd || existing.cwd);
  const issueNum = issueNumberFromBranch(branch);
  const name     = buildName(repo, title, msg.ts || existing.timestamp, issueNum);
  const updated = { ...existing, repo, cwd: msg.cwd || existing.cwd, title, name,
                    timestamp: msg.ts || existing.timestamp,
                    finalized: true, first_prompt: msg.text.slice(0, 120),
                    ...(issueNum ? { issue: issueNum } : {}) };
  saveEntry(updated);
  console.log(`[session-namer] ${session.slice(0, 8)}… → "${name}"`);
}

/**
 * cmdFinalizeEarly — finalize a single session without marking finalized if no msg found yet.
 * Called from UserPromptSubmit hook: the transcript may have just one user message written.
 * Does nothing if session is already properly named.
 * NOTE: Does NOT apply the done marker. Only --finalize-close does.
 */
async function cmdFinalizeEarly({ session }) {
  if (!session) { console.error('--session required'); process.exit(1); }
  const existing = loadRegistry().find(e => e.session === session);
  if (!existing) return; // not registered yet — SessionStart may have been missed

  // Already has a real name — nothing to do
  if (existing.finalized && existing.title && existing.title !== 'pending') return;

  // Manually renamed -- never overwrite a /rename-session name with a
  // transcript-derived guess, even before Stop has finalized it.
  if (existing.renamed && existing.title && existing.title !== 'pending') return;

  const msg = await readFirstUserMessage(session, existing.cwd);
  if (!msg) return; // transcript not readable yet — Stop hook will handle it

  const title    = titleFromText(msg.text);
  const repo     = existing.repo !== 'unknown' ? existing.repo : repoFromCwd(msg.cwd);
  const branch   = getGitBranch(msg.cwd || existing.cwd);
  const issueNum = issueNumberFromBranch(branch);
  const name     = buildName(repo, title, msg.ts || existing.timestamp, issueNum);
  const updated = { ...existing, repo, cwd: msg.cwd || existing.cwd, title, name,
                    timestamp: msg.ts || existing.timestamp,
                    finalized: true, first_prompt: msg.text.slice(0, 120),
                    ...(issueNum ? { issue: issueNum } : {}) };
  saveEntry(updated);
  console.log(`[session-namer] early-finalize ${session.slice(0, 8)}… → "${name}"`);
}

/**
 * cmdFinalizeClose — called when a session truly closes (SessionEnd event).
 * Applies the DONE_MARKER to mark a session as finished.
 * Similar to cmdFinalize but explicitly designed for session-close semantics.
 * Idempotent: won't double-mark a session.
 */
async function cmdFinalizeClose({ session }) {
  if (!session) { console.error('--session required'); process.exit(1); }
  const existing = loadRegistry().find(e => e.session === session)
                || { session, repo: 'unknown', cwd: '' };

  // Idempotency: never clobber an already-marked-done session
  if (existing.finalized && existing.title && existing.title !== 'pending' &&
      existing.name && existing.name.endsWith(DONE_MARKER)) return;

  // If we don't have a real title yet, don't mark done (nothing to mark)
  if (!existing.title || existing.title === 'pending') return;

  // Apply done marker to an already-named session
  const name   = applyDoneMarker(existing.name, existing.title);
  const repo   = existing.repo || 'unknown';
  const slug   = existing.slug || slugFromBranch(getGitBranch(existing.cwd), existing.title);
  const status = 'done';
  const statusName = buildStatusName(repo, slug, existing.timestamp, status);
  saveEntry({ ...existing, finalized: true, name, slug, status, statusName });
  console.log(`[session-namer] close-finalize ${session.slice(0, 8)}… → "${name}"`);
}

/**
 * cmdSweep — retroactively finalize all registry entries stuck at finalized:false
 * (or finalized:true with title="pending") whose transcripts now have a readable first prompt.
 * Also retro-applies DONE_MARKER to already-finalized entries that predate this feature.
 * Safe: never clobbers entries that already have a real title.
 * Designed to run on SessionStart so past crashes self-heal over time.
 */
async function cmdSweep() {
  let entries = loadRegistry();

  // Pass 0 (one-time cleanup): a prior bug applied DONE_MARKER to sessions
  // that were still "pending" (never got a real title), producing names like
  // "myrepo pending 2026-07-02 + (done)". Strip the stray marker. Back up the
  // registry first since this rewrites data.
  const dirtyPending = entries.filter(e =>
    e.title === 'pending' && e.name && e.name.endsWith(DONE_MARKER)
  );
  if (dirtyPending.length > 0) {
    const backupPath = `${REGISTRY}.bak-${Date.now()}`;
    writeFileSync(backupPath, readFileSync(REGISTRY, 'utf8'), 'utf8');
    for (const entry of dirtyPending) {
      saveEntry({ ...entry, name: stripDoneMarker(entry.name) });
    }
    console.log(`[session-namer] sweep: cleaned ${dirtyPending.length} pending session(s) with a stray done-marker (backup: ${backupPath})`);
    entries = loadRegistry();
  }

  // Pass 1: Check for entries that lost the done marker (shouldn't happen, but defensive).
  // Don't retroactively apply the done marker here — only SessionEnd (--finalize-close) should do that.
  // Keep entries as-is if they predate the close-finalize feature.

  const pending = entries.filter(e =>
    !e.renamed && (!e.finalized || e.title === 'pending' || !e.title)
  );

  if (!pending.length) {
    console.log('[session-namer] sweep: no pending sessions');
    return;
  }

  let fixed = 0; let skipped = 0;
  for (const entry of pending) {
    const msg = await readFirstUserMessage(entry.session, entry.cwd);
    if (!msg) { skipped++; continue; }

    const title    = titleFromText(msg.text);
    const repo     = (entry.repo && entry.repo !== 'unknown') ? entry.repo : repoFromCwd(msg.cwd);
    const branch   = getGitBranch(msg.cwd || entry.cwd);
    const issueNum = issueNumberFromBranch(branch);
    const name     = buildName(repo, title, msg.ts || entry.timestamp, issueNum);
    const updated = { ...entry, repo, cwd: msg.cwd || entry.cwd, title, name,
                      timestamp: msg.ts || entry.timestamp,
                      finalized: true, first_prompt: msg.text.slice(0, 120),
                      ...(issueNum ? { issue: issueNum } : {}) };
    saveEntry(updated);
    console.log(`[session-namer] sweep fixed ${entry.session.slice(0, 8)}… → "${name}"`);
    fixed++;
  }

  console.log(`[session-namer] sweep done — fixed: ${fixed}, no-transcript: ${skipped}`);
}

/**
 * getGitBranch — best-effort current branch name for a cwd. Used to build the
 * startup title "<repo>/<branch>" before the real (first-prompt-derived) name
 * exists. Never throws; returns null if not a git repo or on any error. Bounded
 * by a short timeout so a slow/hung git process can't block session startup.
 */
function getGitBranch(cwd) {
  if (!cwd) return null;
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd, timeout: 1500, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const branch = out.toString().trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

/**
 * cmdPrintTitle — print (stdout only) the best-available display title for a
 * session, for the SessionStart hook to forward into Claude Code's native
 * sessionTitle mechanism.
 *   - Resume of an already-finalized session -> the real registry name (keeps
 *     the " + (done)" marker so finished sessions read as done in the picker).
 *   - Fresh session / no real title yet -> "<repo>/<branch>" (or
 *     "<repo> <date>" if branch can't be determined). The good
 *     first-prompt-derived name then appears on the *next* resume — Claude
 *     Code only lets SessionStart (not UserPromptSubmit/Stop) set the title,
 *     so there is no way to rename mid-session once the first prompt lands.
 * Prints nothing if no session id is given (hook then skips JSON emission).
 */
async function cmdPrintTitle({ session, cwd }) {
  if (!session) return;
  const existing = loadRegistry().find(e => e.session === session);

  // Show the real name whenever one exists — whether it came from the
  // transcript-derived finalize path or a manual /rename-session, even if
  // the session hasn't been marked finalized yet (e.g. renamed mid-session
  // before Stop ever fired).
  if (existing && existing.name && existing.title && existing.title !== 'pending') {
    process.stdout.write(existing.name);
    return;
  }

  const effectiveCwd = cwd || existing?.cwd || '';
  const repo   = repoFromCwd(effectiveCwd);
  const branch = getGitBranch(effectiveCwd || process.cwd());
  // issue #166: reuse buildStatusName pieces for a richer start title —
  // "<repo> · <branch-slug> · <YYMMDD-HHmm> · started" — instead of the bare
  // "<repo>/<branch>". Falls back to the old "<repo> <date>" form when there
  // is no branch to slug (e.g. cwd isn't a git repo).
  const title  = branch
    ? `${repo} · ${slugFromBranch(branch)} · ${formatStamp()} · started`
    : `${repo} ${today()}`;
  process.stdout.write(title);
}

function cmdList({ repo, date, limit }) {
  let rows = loadRegistry();
  if (repo)  rows = rows.filter(e => e.repo.toLowerCase().includes(repo.toLowerCase()));
  if (date)  rows = rows.filter(e => dateStr(e.timestamp) === date);
  rows.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  if (limit) rows = rows.slice(0, parseInt(limit, 10));

  if (!rows.length) { console.log('No sessions found.'); return; }

  const w = Math.min(55, Math.max(20, ...rows.map(r => (r.name || '').length)));
  console.log(`${'SESSION'.padEnd(8)}  ${'NAME'.padEnd(w)}  FIRST PROMPT`);
  console.log('─'.repeat(8 + w + 50));
  for (const r of rows) {
    const preview = (r.first_prompt || r.title || '').replace(/\n/g, ' ').slice(0, 40);
    console.log(`${(r.session || '').slice(0, 8)}  ${(r.name || '').padEnd(w)}  ${preview}`);
  }
}

function cmdSearch(query) {
  if (!query) { console.error('query required'); process.exit(1); }
  const q = query.toLowerCase();
  const matches = loadRegistry()
    .filter(e =>
      e.name?.toLowerCase().includes(q) ||
      e.repo?.toLowerCase().includes(q) ||
      e.title?.toLowerCase().includes(q) ||
      e.first_prompt?.toLowerCase().includes(q) ||
      e.session?.startsWith(q)
    )
    .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  if (!matches.length) { console.log(`No matches for "${query}"`); return; }
  console.log(`${matches.length} session(s) matching "${query}":\n`);
  for (const r of matches) {
    const projectDirName = r.cwd ? cwdToProjectDir(r.cwd) : null;
    const transcript     = projectDirName
      ? join(PROJECTS_DIR, projectDirName, `${r.session}.jsonl`) : null;
    console.log(`  ${r.session}`);
    console.log(`  Name  : ${r.name}`);
    console.log(`  Date  : ${dateStr(r.timestamp)}  Repo: ${r.repo}`);
    if (r.first_prompt) console.log(`  Prompt: ${r.first_prompt.slice(0, 80)}`);
    if (transcript)     console.log(`  Resume: claude --continue "${transcript}"`);
    console.log();
  }
}

function cmdGroup({ by }) {
  const all = loadRegistry().sort((a, b) => (b.timestamp||'').localeCompare(a.timestamp||''));

  const groupBy = by || 'repo';
  const key     = groupBy === 'date'
    ? e => dateStr(e.timestamp)
    : e => e.repo || 'unknown';

  const groups = {};
  for (const e of all) { const k = key(e); (groups[k] = groups[k] || []).push(e); }

  const sorted = Object.entries(groups).sort(([a],[b]) =>
    groupBy === 'date' ? b.localeCompare(a) : a.localeCompare(b)
  );

  for (const [label, rows] of sorted) {
    console.log(`\n── ${label} (${rows.length}) ──`);
    for (const r of rows) {
      const d = dateStr(r.timestamp);
      const t = (r.title || 'pending').slice(0, 40);
      console.log(`  ${d}  ${r.session.slice(0, 8)}…  ${t}`);
    }
  }
}

function cmdRename(sessionId, newName) {
  if (!sessionId) { console.error('session ID required'); process.exit(1); }
  if (!newName || !newName.trim()) { console.error('new name required'); process.exit(1); }
  const entry = loadRegistry().find(e => e.session.startsWith(sessionId));
  if (!entry) { console.log('Not in registry — try: node session-namer.js --search ' + sessionId); process.exit(1); }

  // Derive a title slug from the free-form name (consistent with how title is used elsewhere)
  const cleanName = newName.trim();
  const titleSlug = cleanName.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 5).join(' ') || cleanName;

  const updated = { ...entry, name: cleanName, title: titleSlug, renamed: true, renamedAt: new Date().toISOString() };
  saveEntry(updated);
  console.log(`renamed ${entry.session.slice(0, 8)}… → "${cleanName}"`);
}

/**
 * cmdAutoRename — build the `[repo] - [date] - [4-word summary] - [status]`
 * display name from a caller-supplied 4-word summary (issue: better auto
 * names). The summary itself is generated by whichever model invokes this
 * (the /rename-session command, running in-session — no separate API call
 * needed since the calling model already has full conversation context).
 * This function only normalizes the summary to exactly 4 words and formats
 * the deterministic pieces (repo, date, status) — zero AI calls here.
 */
function cmdAutoRename({ sessionId, summary, status }) {
  if (!sessionId) { console.error('session ID required'); process.exit(1); }
  if (!summary || !summary.trim()) { console.error('4-word summary required'); process.exit(1); }
  const entry = loadRegistry().find(e => e.session.startsWith(sessionId));
  if (!entry) { console.log('Not in registry — try: node session-namer.js --search ' + sessionId); process.exit(1); }

  const words = summary.trim().split(/\s+/).slice(0, 4).join(' ');
  const st = STATUS_LIFECYCLE.includes(status) ? nextStatus(entry.status, status) : (entry.status || 'started');
  const repo = entry.repo || 'unknown';
  const cleanName = `${repo} - ${dateStr(entry.timestamp)} - ${words} - ${st}`;

  const updated = { ...entry, name: cleanName, title: words, status: st,
                     renamed: true, renamedAt: new Date().toISOString() };
  saveEntry(updated);
  console.log(`renamed ${entry.session.slice(0, 8)}… → "${cleanName}"`);
}

function cmdResume(sessionId) {
  if (!sessionId) { console.error('session ID required'); process.exit(1); }
  const entry = loadRegistry().find(e => e.session.startsWith(sessionId));
  if (!entry) { console.log('Not in registry — try: node session-namer.js --search ' + sessionId); return; }

  const projectDirName = entry.cwd ? cwdToProjectDir(entry.cwd) : null;
  const transcript     = projectDirName
    ? join(PROJECTS_DIR, projectDirName, `${entry.session}.jsonl`) : null;

  console.log(`Session  : ${entry.session}`);
  console.log(`Name     : ${entry.name}`);
  console.log(`Repo     : ${entry.repo}  (${entry.cwd})`);
  console.log(`Date     : ${dateStr(entry.timestamp)}`);
  if (entry.first_prompt) console.log(`Prompt   : ${entry.first_prompt.slice(0, 100)}`);
  if (transcript)         console.log(`\nResume:\n  claude --continue "${transcript}"`);
}

async function cmdScan() {
  console.log('[session-namer] scanning ~/.claude/projects/ ...');
  let registered = 0; let named = 0;
  for (const dirName of readdirSync(PROJECTS_DIR)) {
    const dirPath = join(PROJECTS_DIR, dirName);
    const cwd     = '/' + dirName.replace(/^-/, '').replace(/-/g, '/');
    const repo    = repoFromCwd(cwd);
    let files;
    try { files = readdirSync(dirPath).filter(f => f.endsWith('.jsonl')); }
    catch { continue; }

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      if (loadRegistry().find(e => e.session === sessionId && e.finalized)) continue;
      if (!loadRegistry().find(e => e.session === sessionId)) {
        const ts = new Date().toISOString();
        saveEntry({ session: sessionId, repo, cwd, title: 'pending',
                    name: buildName(repo, 'pending', ts), timestamp: ts, finalized: false });
        registered++;
      }
      await cmdFinalize({ session: sessionId });
      named++;
    }
  }
  console.log(`[session-namer] done — registered: ${registered}, named: ${named}`);
}

// ── Arg parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {}; const positional = [];
for (const arg of args) {
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    if (eq >= 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    else         flags[arg.slice(2)]      = true;
  } else positional.push(arg);
}

async function main() {
  if      (flags.register)              cmdRegister({ session: flags.session, cwd: flags.cwd || process.env.CWD || process.cwd() });
  else if (flags.finalize)              await cmdFinalize({ session: flags.session });
  else if (flags['finalize-close'])     await cmdFinalizeClose({ session: flags.session });
  else if (flags['set-status'])         cmdSetStatus({ session: flags.session, status: flags['set-status'] === true ? flags.status : flags['set-status'] });
  else if (flags['finalize-early'])     await cmdFinalizeEarly({ session: flags.session });
  else if (flags.sweep)                 await cmdSweep();
  else if (flags['print-title'])        await cmdPrintTitle({ session: flags.session, cwd: flags.cwd });
  else if (flags.scan)                  { await cmdScan(); await cmdScanAgy(); }
  else if (flags.list)                  cmdList({ repo: flags.repo, date: flags.date, limit: flags.limit });
  else if (flags.search || positional.length && !flags.group && !flags.rename && !flags.resume && !flags['auto-rename'])
                                        cmdSearch(flags.search !== true ? flags.search : positional.join(' '));
  else if (flags.group)                 cmdGroup({ by: flags.by });
  else if (flags.resume)                cmdResume(flags.resume !== true ? flags.resume : positional[0]);
  else if (flags.rename)                cmdRename(positional[0], positional.slice(1).join(' '));
  else if (flags['auto-rename'])        cmdAutoRename({ sessionId: positional[0], summary: positional.slice(1).join(' '), status: flags.status });
  else if (flags.today)                 cmdList({ date: today() });
  else {
    console.log(`session-namer.js — Claude Code session naming & search

Commands:
  --register --session=ID [--cwd=PATH]   Register session on start (hook)
  --finalize --session=ID                Name session from first prompt (Stop hook, no marker)
  --finalize-close --session=ID          Apply done marker on session close (SessionEnd hook)
  --set-status=pr|done --session=ID      Deterministic status-lifecycle transition (no AI; see issue #158)
  --finalize-early --session=ID          Name session early, skip if no transcript yet (UserPromptSubmit hook)
  --sweep                                Retroactively finalize all pending sessions with transcripts
  --print-title --session=ID [--cwd=PATH] Print best display title (SessionStart hook)
  --scan                                 Retroactively name all sessions
  --list [--repo=X] [--date=YYYY-MM-DD] [--limit=N]
  --today                                Today's sessions
  --search QUERY                         Search by name, repo, prompt
  --group [--by=repo|date]               Grouped view
  --resume SESSION_ID                    Show info + resume command
  --rename SESSION_ID "new name"         Manually rename a session (verbatim name)
  --auto-rename SESSION_ID "4 word summary" [--status=started|pr|done]
                                          Build "<repo> - <date> - <4-word summary> - <status>"

Registry: ${REGISTRY}
`);
  }
}

// Only auto-run the CLI when this file is executed directly (e.g.
// `node tools/session-namer.js --sweep`), not when it's `import`ed by the
// test suite to unit-test pure helpers like cwdToProjectDir.
//
// The comparison MUST realpath argv[1] -- see tools/is-main.js for why. This file is where that
// bug was first found: every production caller reaches it through the ~/dev/AgentSystem symlink
// (installed hooks, /rename-session), so the check never matched and the tool exited 0 having
// done absolutely nothing. Regression-tested in tools/session-namer-symlink.test.js.
const isMain = isMainModule(import.meta.url);
if (isMain) main();

// ═══════════════════════════════════════════════════════════════════════════
// Antigravity CLI (agy) support
// Transcripts: ~/.gemini/antigravity-cli/brain/[session-id]/.system_generated/logs/transcript.jsonl
// Format: { source: "USER_EXPLICIT", type: "USER_INPUT", created_at, content: "<USER_REQUEST>text</USER_REQUEST>..." }
// cwd map: ~/.gemini/antigravity-cli/cache/last_conversations.json  (cwd → latest-session-id)
// history: ~/.gemini/antigravity-cli/history.jsonl  (timestamp ms, workspace, display)
// ═══════════════════════════════════════════════════════════════════════════

const AGY_BRAIN_DIR    = join(HOME, '.gemini', 'antigravity-cli', 'brain');
const AGY_LAST_CONV    = join(HOME, '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json');
const AGY_HISTORY      = join(HOME, '.gemini', 'antigravity-cli', 'history.jsonl');

/** Build session-id → cwd map for agy sessions */
function buildAgyCwdMap() {
  const map = new Map();   // session-id → cwd

  // 1. Invert last_conversations.json (cwd → latest-session-id)
  if (existsSync(AGY_LAST_CONV)) {
    try {
      const lc = JSON.parse(readFileSync(AGY_LAST_CONV, 'utf8'));
      for (const [cwd, sid] of Object.entries(lc)) map.set(sid, cwd);
    } catch { /* ignore */ }
  }

  // 2. Timestamp correlation via history.jsonl for unmapped sessions
  let histEntries = [];
  if (existsSync(AGY_HISTORY)) {
    try {
      histEntries = readFileSync(AGY_HISTORY, 'utf8')
        .split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(e => e && e.timestamp && e.workspace);
    } catch { /* ignore */ }
  }

  if (histEntries.length && existsSync(AGY_BRAIN_DIR)) {
    for (const dir of readdirSync(AGY_BRAIN_DIR)) {
      if (map.has(dir)) continue;   // already mapped
      const transcript = join(AGY_BRAIN_DIR, dir, '.system_generated', 'logs', 'transcript.jsonl');
      if (!existsSync(transcript)) continue;

      // Get first message ISO timestamp, convert to epoch ms
      try {
        const firstLine = readFileSync(transcript, 'utf8').split('\n').find(l => l.trim());
        if (!firstLine) continue;
        const firstMs = Date.parse(JSON.parse(firstLine).created_at);
        if (!firstMs) continue;

        // Find history entries within ±5 min of session start
        const WINDOW = 5 * 60 * 1000;
        const nearby = histEntries.filter(e => Math.abs(e.timestamp - firstMs) < WINDOW);
        if (!nearby.length) continue;

        // Most common workspace in that window
        const freq = {};
        for (const e of nearby) freq[e.workspace] = (freq[e.workspace] || 0) + 1;
        const best = Object.entries(freq).sort((a,b) => b[1]-a[1])[0][0];
        map.set(dir, best);
      } catch { /* skip */ }
    }
  }

  return map;
}

/** Strip <USER_REQUEST>...</USER_REQUEST> and metadata XML tags from agy content */
function extractAgyUserText(content) {
  if (!content) return '';
  const m = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  return m ? m[1].trim() : content.replace(/<[^>]+>/g, ' ').trim();
}

/** Read first typed user message from an agy transcript */
async function readFirstAgyMessage(brainDir) {
  const transcript = join(brainDir, '.system_generated', 'logs', 'transcript.jsonl');
  if (!existsSync(transcript)) return null;

  return new Promise(resolve => {
    const rl = createInterface({ input: createReadStream(transcript), crlfDelay: Infinity });
    let found = null;
    rl.on('line', line => {
      if (found) return;
      try {
        const obj = JSON.parse(line);
        if (
          obj.source === 'USER_EXPLICIT' &&
          obj.type   === 'USER_INPUT' &&
          obj.content
        ) {
          const text = extractAgyUserText(obj.content);
          if (text.length > 0) {
            found = { text, ts: obj.created_at };
            rl.close();
          }
        }
      } catch { /* skip */ }
    });
    rl.on('close', () => resolve(found));
    rl.on('error',  () => resolve(null));
  });
}

/** Scan all agy brain dirs and register sessions */
async function cmdScanAgy() {
  if (!existsSync(AGY_BRAIN_DIR)) {
    console.log('[session-namer] agy: brain dir not found, skipping');
    return;
  }

  const cwdMap = buildAgyCwdMap();
  let registered = 0; let named = 0;
  const dirs = readdirSync(AGY_BRAIN_DIR);

  for (const sessionId of dirs) {
    const brainDir = join(AGY_BRAIN_DIR, sessionId);
    const existing = loadRegistry().find(e => e.session === sessionId);
    if (existing?.finalized) continue;

    const cwd  = cwdMap.get(sessionId) || '';
    const repo = repoFromCwd(cwd) || 'agy';

    const msg = await readFirstAgyMessage(brainDir);
    const ts  = msg?.ts || new Date().toISOString();

    if (!existing) {
      saveEntry({ session: sessionId, repo, cwd, title: 'pending',
                  name: buildName(repo, 'pending', ts),
                  timestamp: ts, finalized: false, runtime: 'agy' });
      registered++;
    }

    if (msg) {
      const title = titleFromText(msg.text);
      const name  = applyDoneMarker(buildName(repo, title, msg.ts || ts), title);
      const prev  = loadRegistry().find(e => e.session === sessionId) || {};
      saveEntry({ ...prev, session: sessionId, repo, cwd, title, name,
                  timestamp: msg.ts || ts, finalized: true,
                  first_prompt: msg.text.slice(0, 120), runtime: 'agy' });
      console.log(`[session-namer][agy] ${sessionId.slice(0,8)}… → "${name}"`);
      named++;
    } else {
      // No transcript message found yet. If this session was freshly
      // registered above it's already pending; if it already existed and
      // still has no message, leave it pending too — do not finalize or
      // apply the done marker (there is no real title to mark "done").
    }
  }

  console.log(`[session-namer][agy] done — registered: ${registered}, named: ${named}`);
}
