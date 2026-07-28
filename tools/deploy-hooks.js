#!/usr/bin/env node
// deploy-hooks.js — sync repo runtime files to ~/.claude so fixes actually reach runtime,
// and register them in ~/.claude/settings.json so Claude Code actually runs them.
// Fixes #150: hooks drift (repo fixed, installed copies stale, bugs keep firing).
//
// Copying alone is not enough: a hook that is not listed under settings.json's
// `hooks` key never fires. Registration used to live only in
// sync_hooks_from_repo.ps1, so on a Linux host the entire hook pipeline (memory
// injection, routing, compression, session naming, episodic writeback) was
// installed-but-inert. That manifest is ported here so one cross-platform
// command does both halves.
//
// Usage:
//   node tools/deploy-hooks.js           # copy changed files + register hooks
//   node tools/deploy-hooks.js --check   # dry-run: exit 1 on any file drift or missing registration
//
// Pure Node.js builtins only (repo rule for tools/).

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE_HOME = join(homedir(), '.claude');

// Mapping: repo source -> install destination.
// hooks/*.js and hooks/claude-hooks/*.sh -> ~/.claude/hooks/
// webhook server -> ~/.claude/remote-control-server.js
function buildManifest() {
  const manifest = [];
  const hooksDir = join(REPO, 'hooks');
  for (const f of readdirSync(hooksDir)) {
    if (f.endsWith('.js') && !f.endsWith('.test.js')) {
      manifest.push({ src: join(hooksDir, f), dest: join(CLAUDE_HOME, 'hooks', f) });
    }
  }
  // The hooks are CommonJS. Without this, module type resolves by walking up from
  // ~/.claude/hooks to $HOME, so any parent package.json declaring "type":"module"
  // would break every hook at once.
  const hooksPkg = join(hooksDir, 'package.json');
  if (existsSync(hooksPkg)) {
    manifest.push({ src: hooksPkg, dest: join(CLAUDE_HOME, 'hooks', 'package.json') });
  }
  const shDir = join(hooksDir, 'claude-hooks');
  if (existsSync(shDir)) {
    for (const f of readdirSync(shDir)) {
      if (f.endsWith('.sh')) {
        manifest.push({ src: join(shDir, f), dest: join(CLAUDE_HOME, 'hooks', f) });
      }
    }
  }
  const server = join(REPO, 'tools', 'mission-control', 'webhook-server.js');
  if (existsSync(server)) {
    manifest.push({ src: server, dest: join(CLAUDE_HOME, 'remote-control-server.js') });
  }
  return manifest;
}

function sha(path) {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
  catch { return null; }
}

export function diffManifest(manifest = buildManifest()) {
  const out = [];
  for (const { src, dest } of manifest) {
    const srcHash = sha(src);
    if (srcHash === null) continue;
    const destHash = sha(dest);
    out.push({
      src, dest, name: basename(src),
      status: destHash === null ? 'missing' : destHash === srcHash ? 'same' : 'drift',
    });
  }
  return out;
}

export function deploy(manifest = buildManifest()) {
  const results = diffManifest(manifest);
  for (const r of results) {
    if (r.status !== 'same') {
      mkdirSync(dirname(r.dest), { recursive: true });
      writeFileSync(r.dest, readFileSync(r.src));
      r.deployed = true;
    }
  }
  return results;
}

// ── Hook registration ─────────────────────────────────────────────────────────
// Ported from sync_hooks_from_repo.ps1. `n(f)` = node hook, `b(f)` = bash hook;
// both resolve to the deployed copy under ~/.claude/hooks.
const HOOKS_DIR = join(CLAUDE_HOME, 'hooks').replaceAll('\\', '/');
const n = f => `node "${HOOKS_DIR}/${f}"`;
const b = f => `bash "${HOOKS_DIR}/${f}"`;

export const HOOK_REGISTRY = [
  { event: 'SessionStart',     command: n('memory-context-inject.js'),          timeout: 10, statusMessage: 'Loading memory context...' },
  { event: 'SessionStart',     command: n('routines-context-inject.js'),        timeout: 5,  statusMessage: 'Loading enforced routines...' },
  { event: 'SessionStart',     command: b('session-start.sh'),                  timeout: 10, statusMessage: 'Starting session...' },
  { event: 'UserPromptSubmit', command: n('memory-router.js'),                  timeout: 5,  statusMessage: 'Routing...' },
  { event: 'UserPromptSubmit', command: b('user-prompt-submit.sh'),             timeout: 5,  statusMessage: 'Registering prompt...' },
  { event: 'SessionEnd',       command: n('memory-capture-hook.js'),            timeout: 5,  statusMessage: 'Capturing memory...' },
  { event: 'SessionEnd',       command: b('session-close.sh'),                  timeout: 10, statusMessage: 'Finalizing session...' },
  // routine-dispatch is Bash-scoped: its payload inspection only ever applies to
  // Bash events (see the 2026-07-12 audit notes in the retired .ps1).
  { event: 'PostToolUse',      command: b('wip-checkpoint.sh'),                 timeout: 5,  statusMessage: 'Saving checkpoint...',          matcher: 'Write|Edit|NotebookEdit' },
  { event: 'PostToolUse',      command: n('routine-dispatch.js'),               timeout: 5,  statusMessage: 'Checking routines (Bash)...',   matcher: 'Bash' },
  // NOT registered: tool-output-compress.js. A PostToolUse hook can only *append*
  // context — it cannot replace the tool result. The original output stays in the
  // transcript in full and the hook adds a 3.2KB "compressed preview" on top, so
  // it costs ~800 tokens per large Bash result instead of saving any. Measured on
  // a 10,000-char payload: context grew by 3218 chars. See hooks/tool-output-compress.js.
  { event: 'PreToolUse',       command: b('guard-git.sh'),                      timeout: 5,  statusMessage: 'Guarding git...',               matcher: 'Bash' },
  { event: 'Stop',             command: n('sona-writeback-hook.js'),            timeout: 5,  statusMessage: 'Writing episodic memory...' },
  { event: 'Stop',             command: n('injection-feedback-hook.js'),        timeout: 5,  statusMessage: 'Scoring memory usefulness...' },
  { event: 'Stop',             command: n('routine-compliance-hook.js'),        timeout: 5,  statusMessage: 'Checking routine compliance...' },
  { event: 'Stop',             command: b('session-end.sh'),                    timeout: 5,  statusMessage: 'Ending session...' },
  { event: 'SubagentStart',    command: n('memory-context-inject-subagent.js'), timeout: 3,  statusMessage: 'Injecting subagent memory...' },
  { event: 'SubagentStop',     command: n('sona-writeback-hook.js'),            timeout: 5,  statusMessage: 'Writing episodic memory...' },
  { event: 'PreCompact',       command: b('context-handoff.sh'),                timeout: 5,  statusMessage: 'Generating handoff doc...' },
];

const SETTINGS_DEFAULTS = { autoCompactEnabled: true, autoCompactWindow: 150000 };

const settingsPath = () => join(CLAUDE_HOME, 'settings.json');
const normCmd = c => String(c).replaceAll("'", '"').replaceAll('\\', '/');

/**
 * Merge HOOK_REGISTRY into a settings object. Idempotent — the command string is
 * the identity key, so re-running never duplicates an entry. Returns the list of
 * changes that were (or would be) applied.
 */
export function mergeHookSettings(settings, registry = HOOK_REGISTRY) {
  const changes = [];
  for (const [k, v] of Object.entries(SETTINGS_DEFAULTS)) {
    if (settings[k] !== v) { settings[k] = v; changes.push(`${k} -> ${v}`); }
  }
  settings.hooks ??= {};
  for (const entry of registry) {
    const { event, command, matcher, timeout, statusMessage } = entry;
    settings.hooks[event] ??= [];
    const groups = settings.hooks[event];
    let group = groups.find(g => (g.matcher ?? null) === (matcher ?? null));
    if (!group) {
      group = matcher ? { matcher, hooks: [] } : { hooks: [] };
      groups.push(group);
    }
    group.hooks ??= [];
    if (group.hooks.some(h => normCmd(h?.command) === normCmd(command))) continue;
    group.hooks.push({ type: 'command', command, timeout, statusMessage });
    changes.push(`${event}${matcher ? `[${matcher}]` : ''} -> ${command}`);
  }
  return changes;
}

function readSettings() {
  try { return JSON.parse(readFileSync(settingsPath(), 'utf8')); }
  catch { return {}; }
}

export function registerHooks({ dryRun = false } = {}) {
  const settings = readSettings();
  const changes = mergeHookSettings(settings);
  if (changes.length && !dryRun) {
    mkdirSync(CLAUDE_HOME, { recursive: true });
    // Back up once per run before rewriting the user's live settings.
    if (existsSync(settingsPath())) {
      writeFileSync(settingsPath() + '.bak', readFileSync(settingsPath()));
    }
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + '\n');
  }
  return changes;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === (await import('node:path')).resolve(process.argv[1]);
if (isMain) {
  const check = process.argv.includes('--check');
  const results = check ? diffManifest() : deploy();
  let drift = 0;
  for (const r of results) {
    if (r.status === 'same') { if (!check) continue; }
    else drift++;
    console.log(`${r.status.padEnd(7)} ${r.name}${r.deployed ? '  -> deployed' : ''}`);
  }

  const changes = registerHooks({ dryRun: check });
  for (const c of changes) console.log(`${(check ? 'unreg' : 'reg').padEnd(7)} ${c}`);

  const total = drift + changes.length;
  if (check) {
    console.log(total
      ? `\n${drift} file(s) drifted, ${changes.length} registration(s) missing — run: node tools/deploy-hooks.js`
      : 'in sync');
    process.exit(total ? 1 : 0);
  } else {
    console.log(`\n${drift} file(s) deployed, ${changes.length} hook(s) registered`);
  }
}
