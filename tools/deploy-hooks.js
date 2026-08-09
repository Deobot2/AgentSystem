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
//   node tools/deploy-hooks.js           # copy changed files + register hooks + drop stale ones
//   node tools/deploy-hooks.js --check   # dry-run: exit 1 on file drift, missing or stale registration
//
// Registration used to be additive-only, so a hook deleted from the repo kept firing forever from
// a registration nobody could see (#302: tool-output-compress.js fired on every Bash call for two
// weeks after being deleted from the tree). staleRegistrations() closes that: it reports — and
// deploy removes — registrations that point inside ~/.claude/hooks but are no longer in
// HOOK_REGISTRY, or whose target file is gone. Third-party registrations (plugin hooks under
// ~/.claude/plugins/**) are never touched: only paths that resolve *inside* the AgentSystem hooks
// directory are ours to manage.
//
// Pure Node.js builtins only (repo rule for tools/).

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main.js';

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
const n = (f, ...args) => `node "${HOOKS_DIR}/${f}"${args.length ? ` ${args.join(' ')}` : ''}`;
const b = f => `bash "${HOOKS_DIR}/${f}"`;

export const HOOK_REGISTRY = [
  { event: 'SessionStart',     command: n('memory-context-inject.js'),          timeout: 10, statusMessage: 'Loading memory context...' },
  { event: 'SessionStart',     command: n('routines-context-inject.js'),        timeout: 5,  statusMessage: 'Loading enforced routines...' },
  { event: 'SessionStart',     command: b('session-start.sh'),                  timeout: 10, statusMessage: 'Starting session...' },
  // Continuous sync (#341). Two-phase like the auto-renamer: the hook spawns a detached worker and
  // returns in ~80ms, so the 5s timeout is never the git fetch. Start pulls memory and fast-forwards
  // the AgentSystem checkout; end commits and pushes memory. Code is never pulled at session end,
  // and never on the host timer — files must not change under a running session.
  { event: 'SessionStart',     command: n('continuous-sync-hook.js', '--phase=start'), timeout: 5, statusMessage: 'Syncing memory + code...' },
  { event: 'UserPromptSubmit', command: n('memory-router.js'),                  timeout: 5,  statusMessage: 'Routing...' },
  { event: 'UserPromptSubmit', command: b('user-prompt-submit.sh'),             timeout: 5,  statusMessage: 'Registering prompt...' },
  { event: 'SessionEnd',       command: n('memory-capture-hook.js'),            timeout: 5,  statusMessage: 'Capturing memory...' },
  { event: 'SessionEnd',       command: b('session-close.sh'),                  timeout: 10, statusMessage: 'Finalizing session...' },
  // Third SessionEnd hook (see CLAUDE.md "Session Naming"). Two-phase: returns in
  // ~80ms after spawning a detached worker, so the 5s timeout is not the model call.
  { event: 'SessionEnd',       command: n('session-auto-rename-hook.js'),       timeout: 5,  statusMessage: 'Naming session...' },
  { event: 'SessionEnd',       command: n('continuous-sync-hook.js', '--phase=end'), timeout: 5, statusMessage: 'Pushing memory...' },
  // routine-dispatch is Bash-scoped: its payload inspection only ever applies to
  // Bash events (see the 2026-07-12 audit notes in the retired .ps1).
  { event: 'PostToolUse',      command: b('wip-checkpoint.sh'),                 timeout: 5,  statusMessage: 'Saving checkpoint...',          matcher: 'Write|Edit|NotebookEdit' },
  { event: 'PostToolUse',      command: n('routine-dispatch.js'),               timeout: 5,  statusMessage: 'Checking routines (Bash)...',   matcher: 'Bash' },
  // Live-but-unregistered until #302: hand-added to settings.json, so a fresh host never got the
  // #158 session status lifecycle (started -> pr -> done) at all.
  { event: 'PostToolUse',      command: b('pr-status-detect.sh'),               timeout: 5,  statusMessage: 'Detecting PR create...',        matcher: 'Bash' },
  // There is no tool-output-compress.js — it was deleted in 4adeab6 (2026-07-26). Its
  // implementation could only *append*, so compressing a large output meant keeping the
  // original and adding a summary on top: measured at +3218 chars on a 10,000-char payload.
  // PostToolUse can now *replace* a result via hookSpecificOutput.updatedToolOutput, so a
  // redo would actually save. Nobody has asked for one — don't build it on spec.
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

/** Absolute path of the hooks directory this run manages, in comparison form. */
export const hooksDirPath = () => HOOKS_DIR;

// Git Bash writes C:\Users\x as /c/Users/x. Fold that back so both spellings of the same
// file compare equal — the caveman plugin registers itself with a /c/... path.
const gitBashToWin = p => p.replace(/^\/([a-zA-Z])\//, (_, d) => `${d.toUpperCase()}:/`);
const cmpPath = p => (process.platform === 'win32' ? p.toLowerCase() : p);

/**
 * Every filesystem-path-looking token in a command string, normalised.
 * Handles `node "C:/x/y.js"`, `bash 'C:\x\y.sh'` and bare `node /c/x/y.js` alike.
 */
function commandPaths(command) {
  const tokens = normCmd(command).match(/"[^"]*"|\S+/g) ?? [];
  return tokens.map(t => gitBashToWin(t.replace(/^"|"$/g, '')));
}

/**
 * The file inside our hooks dir that `command` runs, or null if the command is not ours.
 * Deliberately a path-prefix test, not a substring test: the caveman plugin's
 * `.../plugins/cache/caveman/.../src/hooks/caveman-activate.js` contains "hooks" but does not
 * live in ~/.claude/hooks, and must never be matched.
 */
export function hooksDirTarget(command) {
  const prefix = cmpPath(HOOKS_DIR.replace(/\/$/, '') + '/');
  for (const p of commandPaths(command)) {
    if (cmpPath(p).startsWith(prefix)) return p;
  }
  return null;
}

const regKey = (event, matcher, command) => `${event}\u0000${matcher ?? ''}\u0000${normCmd(command)}`;

/**
 * Registrations in `settings` that point inside our hooks dir but should not be there:
 * either the event+matcher+command triple is absent from HOOK_REGISTRY, or the file it runs
 * no longer exists and the manifest will not recreate it. Anything outside the hooks dir is
 * someone else's registration and is never reported.
 */
export function staleRegistrations(settings, registry = HOOK_REGISTRY, manifest = null) {
  const out = [];
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== 'object') return out;
  const known = new Set(registry.map(e => regKey(e.event, e.matcher, e.command)));
  const owned = new Set(
    (manifest ?? safeManifest()).map(m => cmpPath(m.dest.replaceAll('\\', '/'))),
  );
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const matcher = group?.matcher ?? null;
      for (const h of group?.hooks ?? []) {
        if (!h?.command) continue;
        const target = hooksDirTarget(h.command);
        if (!target) continue; // not ours
        let reason = null;
        if (!known.has(regKey(event, matcher, h.command))) reason = 'not in HOOK_REGISTRY';
        else if (!existsSync(target) && !owned.has(cmpPath(target))) reason = 'target file missing';
        else continue;
        out.push({ event, matcher, command: h.command, target, reason });
      }
    }
  }
  return out;
}

function safeManifest() {
  try { return buildManifest(); } catch { return []; }
}

/**
 * Remove the stale registrations from `settings`, pruning any group and event array our removal
 * emptied so the file does not accumulate husks. Groups we did not touch are left exactly as
 * found, empty or not. Returns the change lines, and the set of orphan files the caller may
 * delete (see registerHooks).
 */
export function removeStaleHookSettings(settings, registry = HOOK_REGISTRY, manifest = null) {
  const stale = staleRegistrations(settings, registry, manifest);
  if (!stale.length) return { changes: [], orphanFiles: [] };
  const doomed = new Set(stale.map(s => regKey(s.event, s.matcher, s.command)));
  const touched = new Set(stale.map(s => s.event));
  for (const event of touched) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const group of groups) {
      const matcher = group?.matcher ?? null;
      const before = group?.hooks?.length ?? 0;
      if (Array.isArray(group?.hooks)) {
        group.hooks = group.hooks.filter(h => !doomed.has(regKey(event, matcher, h?.command)));
      }
      // Only prune a group our filter emptied — an already-empty foreign group is not ours to drop.
      if (before > 0 && group.hooks?.length === 0) continue;
      kept.push(group);
    }
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  const owned = new Set((manifest ?? safeManifest()).map(m => cmpPath(m.dest.replaceAll('\\', '/'))));
  // Orphan-file deletion is attribution-limited on purpose. We only delete a file when we are
  // simultaneously removing *our own* registration that pointed at it — that registration is the
  // evidence this deploy tool installed the file. A stray file in ~/.claude/hooks with no
  // registration behind it could be something the user dropped there by hand, so it is left alone.
  const orphanFiles = [...new Set(stale
    .filter(s => !owned.has(cmpPath(s.target)) && existsSync(s.target))
    .map(s => s.target))];
  return { changes: stale.map(s => `${s.event}${s.matcher ? `[${s.matcher}]` : ''} -> ${s.command}  (${s.reason})`), orphanFiles };
}

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
  const { changes: removed, orphanFiles } = removeStaleHookSettings(settings);
  const added = mergeHookSettings(settings);
  const deleted = [];
  if ((added.length || removed.length) && !dryRun) {
    mkdirSync(CLAUDE_HOME, { recursive: true });
    // Back up once per run, before the first write that touches the user's live settings.
    if (existsSync(settingsPath())) {
      writeFileSync(settingsPath() + '.bak', readFileSync(settingsPath()));
    }
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + '\n');
    for (const f of orphanFiles) {
      try { rmSync(f); deleted.push(f); } catch { /* already gone, or not ours to remove */ }
    }
  }
  return { added, removed, orphanFiles, deleted };
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const check = process.argv.includes('--check');
  // On a host that has an install, --require-install makes "nothing here" a failure instead of a
  // pass. The self-hosted runner is supposed to have hooks deployed, so a bare-home no-op there is
  // itself the outage (#150's installed-but-inert, one step earlier), not a clean bill of health.
  const requireInstall = process.argv.includes('--require-install');
  const hasHooksDir = existsSync(HOOKS_DIR);
  const hasSettings = existsSync(settingsPath());

  // "Nothing is installed here" is not "everything is in sync". On a hosted CI runner there is no
  // ~/.claude at all, so a --check that reported success would be the green-build-hides-a-dead-
  // thing failure of #275/#292 all over again. Only a COMPLETELY bare home is a clean skip: a
  // hooks dir with no settings.json is the installed-but-inert state this tool exists to catch,
  // so that case still runs the registration half and fails on every missing entry.
  if (check && !hasHooksDir && !hasSettings) {
    console.log('no-install ~/.claude/hooks not found — file drift check skipped');
    console.log('no-install ~/.claude/settings.json not found — registration check skipped');
    if (requireInstall) {
      console.log('\nnothing installed on this host, but --require-install was passed — treating as drift');
      process.exit(1);
    }
    console.log('\nnothing installed on this host — nothing to check (logic covered by tools/deploy-hooks.test.js)');
    process.exit(0);
  }

  let drift = 0;
  {
    const results = check ? diffManifest() : deploy();
    for (const r of results) {
      if (r.status === 'same') { if (!check) continue; }
      else drift++;
      console.log(`${r.status.padEnd(10)} ${r.name}${r.deployed ? '  -> deployed' : ''}`);
    }
  }

  const { added, removed, deleted } = registerHooks({ dryRun: check });
  for (const c of removed) console.log(`${'stale'.padEnd(10)} ${c}`);
  for (const f of deleted) console.log(`${'deleted'.padEnd(10)} ${f}`);
  for (const c of added) console.log(`${(check ? 'unreg' : 'reg').padEnd(10)} ${c}`);

  const total = drift + added.length + removed.length;
  if (check) {
    console.log(total
      ? `\n${drift} file(s) drifted, ${added.length} registration(s) missing, ${removed.length} stale — run: node tools/deploy-hooks.js`
      : 'in sync');
    process.exit(total ? 1 : 0);
  } else {
    console.log(`\n${drift} file(s) deployed, ${added.length} hook(s) registered, ${removed.length} stale registration(s) removed`);
  }
}
