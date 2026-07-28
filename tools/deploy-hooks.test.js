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
  assert.equal(post.find(g => g.matcher === 'Bash').hooks.length, 1);
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
