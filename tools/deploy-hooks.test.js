#!/usr/bin/env node
// Hook registration must be idempotent and must not clobber unrelated settings —
// it rewrites the user's live ~/.claude/settings.json.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mergeHookSettings, HOOK_REGISTRY, staleRegistrations, hooksDirTarget, hooksDirPath,
} from './deploy-hooks.js';

test('registers every manifest entry into empty settings', () => {
  const s = {};
  const changes = mergeHookSettings(s);
  // 18 hooks + autoCompactEnabled + autoCompactWindow
  assert.equal(changes.length, HOOK_REGISTRY.length + 2);
  assert.equal(s.autoCompactEnabled, true);
  assert.equal(s.autoCompactWindow, 150000);
  const commands = Object.values(s.hooks).flatMap(gs => gs.flatMap(g => g.hooks.map(h => h.command)));
  assert.equal(commands.length, HOOK_REGISTRY.length);
});

test('is idempotent — second run changes nothing', () => {
  const s = {};
  mergeHookSettings(s);
  const before = JSON.stringify(s);
  const changes = mergeHookSettings(s);
  assert.deepEqual(changes, []);
  assert.equal(JSON.stringify(s), before);
});

test('preserves unrelated settings and pre-existing foreign hooks', () => {
  const foreign = { type: 'command', command: 'node /plugins/caveman/activate.js' };
  const s = {
    theme: 'dark',
    permissions: { allow: ['Bash'] },
    hooks: { SessionStart: [{ hooks: [foreign] }] },
  };
  mergeHookSettings(s);
  assert.equal(s.theme, 'dark');
  assert.deepEqual(s.permissions, { allow: ['Bash'] });
  const sessionStart = s.hooks.SessionStart.flatMap(g => g.hooks);
  assert.ok(sessionStart.includes(foreign), 'foreign plugin hook was dropped');
});

test('matcher groups stay separate', () => {
  const s = {};
  mergeHookSettings(s);
  const post = s.hooks.PostToolUse;
  const matchers = post.map(g => g.matcher).sort();
  assert.deepEqual(matchers, ['Bash', 'Write|Edit|NotebookEdit']);
  assert.equal(post.find(g => g.matcher === 'Bash').hooks.length, 2); // routine-dispatch + pr-status-detect
  assert.equal(post.find(g => g.matcher === 'Write|Edit|NotebookEdit').hooks.length, 1);
});

// A PostToolUse hook cannot replace a tool result, only append to it, so this one
// added ~800 tokens per large Bash output while claiming to save them.
test('tool-output-compress is deliberately not registered', () => {
  assert.ok(!HOOK_REGISTRY.some(e => /tool-output-compress/.test(e.command)),
    'tool-output-compress costs context rather than saving it — see deploy-hooks.js');
});

// Shipped inert once already: the hook file existed but nothing referenced it.
test('every hook file under hooks/ that is meant to run is registered', () => {
  assert.ok(HOOK_REGISTRY.some(e => e.event === 'SessionEnd' && /session-auto-rename-hook/.test(e.command)),
    'session-auto-rename-hook.js must be a SessionEnd hook or it never runs');
});

test('same command on two events registers under both', () => {
  const s = {};
  mergeHookSettings(s);
  const sona = 'sona-writeback-hook.js';
  assert.ok(s.hooks.Stop.flatMap(g => g.hooks).some(h => h.command.includes(sona)));
  assert.ok(s.hooks.SubagentStop.flatMap(g => g.hooks).some(h => h.command.includes(sona)));
});

test('quote/slash variants are treated as already present', () => {
  const s = {};
  mergeHookSettings(s);
  const entry = s.hooks.Stop[0].hooks[0];
  entry.command = entry.command.replaceAll('"', "'").replaceAll('/', '\\');
  const changes = mergeHookSettings(s);
  assert.deepEqual(changes, [], 'a re-quoted command was re-added as a duplicate');
});

test('pr-status-detect.sh is registered (live-but-unregistered until #302)', () => {
  assert.ok(
    HOOK_REGISTRY.some(e => e.event === 'PostToolUse' && e.matcher === 'Bash' && /pr-status-detect\.sh/.test(e.command)),
    'the #158 session status lifecycle only ran because someone hand-edited settings.json',
  );
});

// ── stale / third-party path attribution (#302) ───────────────────────────────
// The whole safety argument rests on these: we mutate the user's live settings.json, so a
// command that is not ours must never be matched, and "contains the word hooks" is not ours.

const DIR = hooksDirPath();

test('hooksDirTarget matches our own hooks in every spelling we write them', () => {
  assert.equal(hooksDirTarget(`node "${DIR}/memory-router.js"`), `${DIR}/memory-router.js`);
  assert.ok(hooksDirTarget(`bash '${DIR.replaceAll('/', '\\')}\\session-end.sh'`));
});

test('hooksDirTarget ignores third-party plugin hooks', () => {
  // Real registration from a live settings.json: Git-Bash-style path, unquoted, and its own
  // src/hooks/ segment. A substring test on "hooks" would delete the caveman plugin.
  const caveman = 'node /c/Users/natha/.claude/plugins/cache/caveman/caveman/0d95a81d35a9/src/hooks/caveman-activate.js';
  assert.equal(hooksDirTarget(caveman), null);
  assert.equal(hooksDirTarget('node C:/Users/natha/.claude/plugins/x/src/hooks/y.js'), null);
  assert.equal(hooksDirTarget('bash /usr/local/hooks/thing.sh'), null);
});

test('staleRegistrations flags an unregistered hooks-dir command and spares foreign ones', () => {
  const caveman = { type: 'command', command: 'node /c/Users/natha/.claude/plugins/cache/caveman/src/hooks/caveman-activate.js' };
  const s = {
    hooks: {
      PostToolUse: [{
        matcher: 'Bash',
        hooks: [caveman, { type: 'command', command: `node "${DIR}/tool-output-compress.js"` }],
      }],
    },
  };
  const stale = staleRegistrations(s);
  assert.equal(stale.length, 1);
  assert.match(stale[0].command, /tool-output-compress\.js/);
  assert.equal(stale[0].event, 'PostToolUse');
  assert.equal(stale[0].matcher, 'Bash');
});

test('staleRegistrations flags a registration whose target file is gone', () => {
  const ghost = `${DIR}/no-such-hook-302.js`;
  assert.equal(existsSync(ghost), false, 'fixture assumed this file does not exist');
  const s = { hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${ghost}"` }] }] } };
  const stale = staleRegistrations(s);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].target, ghost);
});

test('staleRegistrations is quiet on settings this tool just wrote', () => {
  const s = {};
  mergeHookSettings(s);
  assert.deepEqual(staleRegistrations(s), []);
});

// ── CLI, driven against a sandboxed HOME ──────────────────────────────────────
// os.homedir() on win32 reads USERPROFILE and IGNORES HOME. Seeding only HOME would send every
// one of these tests at the developer's REAL ~/.claude/settings.json. Both, always — and the
// last test in this file asserts the real file was never touched.

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'deploy-hooks.js');
const REAL_SETTINGS = join(homedir(), '.claude', 'settings.json');
const realBefore = existsSync(REAL_SETTINGS)
  ? { body: readFileSync(REAL_SETTINGS, 'utf8'), mtime: statSync(REAL_SETTINGS).mtimeMs }
  : null;
const sandboxes = [];

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'deploy-hooks-'));
  sandboxes.push(home);
  return home;
}

function runCli(home, args = []) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
}

const sandboxHooks = home => join(home, '.claude', 'hooks').replaceAll('\\', '/');

test('--check on a host with nothing installed says so and exits 0', () => {
  const home = sandbox();
  const r = runCli(home, ['--check']);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /no-install .*settings\.json not found/);
  assert.match(r.stdout, /no-install .*hooks not found/);
  assert.doesNotMatch(r.stdout, /^in sync$/m, 'an empty host must not be reported as in sync');
});

test('--require-install turns a bare host into a failure', () => {
  // The self-hosted runner is MEANT to have hooks deployed. A bare home there is the outage,
  // one step earlier than #150's installed-but-inert, so the daily job must not read it as clean.
  const r = runCli(sandbox(), ['--check', '--require-install']);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /--require-install/);
});

test('a hooks dir with no settings.json is installed-but-inert, not a clean skip', () => {
  // The exact #150 state: files copied, nothing registered, so no hook ever fires. Skipping the
  // registration half here because settings.json is absent would report that outage as success.
  const home = sandbox();
  mkdirSync(sandboxHooks(home), { recursive: true });
  const r = runCli(home, ['--check']);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /^unreg /m, 'every registration is missing and must be reported');
  assert.doesNotMatch(r.stdout, /nothing installed on this host/);
});

test('stale registrations are detected, removed, and nothing else is disturbed', () => {
  const home = sandbox();
  const hooks = sandboxHooks(home);
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(home, '.claude', 'hooks', 'tool-output-compress.js'), '// deleted from the repo in 4adeab6\n');
  // Verbatim from a live settings.json: unquoted, Git-Bash spelling, its own src/hooks/ segment.
  const cavemanCmd = 'node /c/Users/natha/.claude/plugins/cache/caveman/caveman/0d95a81d35a9/src/hooks/caveman-activate.js';
  const seed = {
    env: {},
    permissions: { defaultMode: 'bypassPermissions' },
    theme: 'dark',
    enabledPlugins: { 'caveman@caveman': true },
    hooks: {
      SubagentStart: [{ hooks: [{ type: 'command', command: cavemanCmd }] }],
      PostToolUse: [{
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: `node "${hooks}/tool-output-compress.js"`, timeout: 5 },
          { type: 'command', command: `node "${hooks}/no-such-hook-302.js"`, timeout: 5 },
        ],
      }],
    },
  };
  const settingsFile = join(home, '.claude', 'settings.json');
  const seedText = JSON.stringify(seed, null, 2) + '\n';
  writeFileSync(settingsFile, seedText);

  // 1. --check reports both stale entries, not the caveman one, and fails.
  const check = runCli(home, ['--check']);
  assert.equal(check.code, 1, check.stdout);
  assert.match(check.stdout, /^stale .*tool-output-compress\.js/m);
  assert.match(check.stdout, /^stale .*no-such-hook-302\.js/m);
  assert.doesNotMatch(check.stdout, /caveman/, 'a third-party plugin hook was reported as ours');
  assert.equal(readFileSync(settingsFile, 'utf8'), seedText, '--check must not write');

  // 2. deploy removes them and deletes the orphan file it can attribute.
  const dep = runCli(home);
  assert.equal(dep.code, 0, dep.stdout);
  const after = JSON.parse(readFileSync(settingsFile, 'utf8'));
  const post = after.hooks.PostToolUse.find(g => g.matcher === 'Bash').hooks.map(h => h.command);
  assert.ok(!post.some(c => /tool-output-compress|no-such-hook-302/.test(c)), 'stale registration survived deploy');
  assert.ok(post.some(c => /routine-dispatch\.js/.test(c)) && post.some(c => /pr-status-detect\.sh/.test(c)));
  assert.equal(existsSync(join(home, '.claude', 'hooks', 'tool-output-compress.js')), false,
    'the orphan file behind the stale registration should be gone');

  // 3. Every unrelated key round-trips byte-identically, plugin hook included.
  assert.deepEqual(after.env, seed.env);
  assert.deepEqual(after.permissions, seed.permissions);
  assert.equal(after.theme, 'dark');
  assert.deepEqual(after.enabledPlugins, seed.enabledPlugins);
  assert.deepEqual(after.hooks.SubagentStart[0].hooks[0], { type: 'command', command: cavemanCmd });

  // 4. Backup written once, holding the pre-run content.
  assert.equal(readFileSync(settingsFile + '.bak', 'utf8'), seedText);

  // 5. Idempotent: a second deploy changes nothing, and --check comes back clean.
  const body = readFileSync(settingsFile, 'utf8');
  const again = runCli(home);
  assert.match(again.stdout, /0 file\(s\) deployed, 0 hook\(s\) registered, 0 stale/);
  assert.equal(readFileSync(settingsFile, 'utf8'), body);
  assert.equal(readFileSync(settingsFile + '.bak', 'utf8'), seedText, '.bak was rewritten on a no-op run');
  const clean = runCli(home, ['--check']);
  assert.equal(clean.code, 0, clean.stdout);
  assert.match(clean.stdout, /in sync/);
});

test('the real ~/.claude/settings.json was never touched by this suite', () => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  if (!realBefore) return;
  assert.equal(readFileSync(REAL_SETTINGS, 'utf8'), realBefore.body, 'SANDBOX ESCAPE: real settings.json content changed');
  assert.equal(statSync(REAL_SETTINGS).mtimeMs, realBefore.mtime, 'SANDBOX ESCAPE: real settings.json was rewritten');
});
