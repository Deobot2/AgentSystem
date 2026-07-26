#!/usr/bin/env node
// Hook registration must be idempotent and must not clobber unrelated settings —
// it rewrites the user's live ~/.claude/settings.json.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeHookSettings, HOOK_REGISTRY } from './deploy-hooks.js';

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
  // Both Bash-scoped hooks land in the one Bash group.
  assert.equal(post.find(g => g.matcher === 'Bash').hooks.length, 2);
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
