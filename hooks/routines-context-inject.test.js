// routines-context-inject.test.js — bypass suppression happens at INJECT time, not compile time.
//
// Why this exists: `routines.js compile` used to filter out bypassed routines. The file it writes,
// .agents/rules/routines.generated.md, is tracked in git, while routine-overrides.json is
// machine-local. So compiling on a host with a stale bypass silently deleted two `enforce: hard`
// routines from the file every session reads — for every machine, via a commit. The suppression
// belongs here, where the local state lives.
//
// Run: node --test hooks/routines-context-inject.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyBypasses } = require('./routines-context-inject.js');

const MD = [
  '<!-- AUTO-GENERATED -->',
  '',
  '# Enforced Routines',
  '',
  '- **always-worktree** (hard): Feature work: create or enter a git worktree first.',
  '- **fix-pr-until-green** (hard): After opening a PR, not DONE until CI is green.',
  '- **memory-write-back** (hard): Persist durable facts immediately.',
  '',
].join('\n');

test('no bypasses leaves the text untouched', () => {
  assert.equal(applyBypasses(MD, []), MD);
});

test('a bypassed routine line is removed', () => {
  const out = applyBypasses(MD, ['always-worktree']);
  assert.doesNotMatch(out, /always-worktree/);
  assert.match(out, /fix-pr-until-green/);
  assert.match(out, /memory-write-back/);
});

test('multiple bypasses are all removed', () => {
  const out = applyBypasses(MD, ['always-worktree', 'fix-pr-until-green']);
  assert.doesNotMatch(out, /always-worktree/);
  assert.doesNotMatch(out, /fix-pr-until-green/);
  assert.match(out, /memory-write-back/, 'unbypassed routines must survive');
});

test('headings and non-routine lines are never dropped', () => {
  const out = applyBypasses(MD, ['always-worktree', 'fix-pr-until-green', 'memory-write-back']);
  assert.match(out, /AUTO-GENERATED/);
  assert.match(out, /# Enforced Routines/);
});

test('an unknown bypass id changes nothing', () => {
  assert.equal(applyBypasses(MD, ['no-such-routine']), MD);
});

test('a bypass id that is a prefix of another does not remove it', () => {
  // `always` must not match `always-worktree`.
  assert.match(applyBypasses(MD, ['always']), /always-worktree/);
});
