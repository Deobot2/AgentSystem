// guard-git.test.js — the only hook in this repo that MECHANICALLY blocks an action.
//
// skills/daily-triage/SKILL.md lists "Never push to `main` in any repo" among its hard limits, but
// until #220 that was prose the model was asked to honour with nothing behind it: the hook blocked
// force-pushes to main and let a plain one through. That became load-bearing when the unattended
// 05:00/13:00 run was cleared to dispatch code items against a CLIENT repo — an agent could have
// written straight to a client's default branch.
//
// Run: node --test hooks/guard-git.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const HOOK = path.join(__dirname, 'claude-hooks', 'guard-git.sh');

/** @returns {number} 2 when the hook blocks, 0 when it allows. */
function run(command, toolName = 'Bash') {
  const input = JSON.stringify({ tool_name: toolName, tool_input: { command } });
  try {
    execFileSync('bash', [HOOK], { input, stdio: ['pipe', 'pipe', 'pipe'] });
    return 0;
  } catch (err) {
    return err.status;
  }
}

// Assembled from fragments so this file's own source cannot trip the deployed PreToolUse hook
// when an agent edits or greps it.
const PUSH = 'git pu' + 'sh';
const MAIN = 'ma' + 'in';
const MASTER = 'mas' + 'ter';

test('blocks a direct push to main, forced or not', () => {
  for (const cmd of [
    `${PUSH} origin ${MAIN}`,
    `${PUSH} -u origin ${MAIN}`,
    `${PUSH} origin HEAD:${MAIN}`,
    `${PUSH} origin ${MASTER}`,
    `${PUSH} --force origin ${MAIN}`,
    `${PUSH} origin ${MAIN} --no-verify`,
  ]) {
    assert.equal(run(cmd), 2, `should have been blocked: ${cmd}`);
  }
});

test('allows pushing any other branch — draft-PR work must not break', () => {
  for (const cmd of [
    `${PUSH} origin my-feature-branch`,
    `${PUSH} -u origin fix/some-thing`,
    `${PUSH} origin feat/${MAIN}-menu`,
  ]) {
    assert.equal(run(cmd), 0, `should have been allowed: ${cmd}`);
  }
});

test('does not false-positive on a branch whose name merely starts with main', () => {
  assert.equal(run(`${PUSH} origin ${MAIN}tenance-branch`), 0);
});

test('leaves non-push git commands alone', () => {
  for (const cmd of [
    `git commit -m 'the ${MAIN} thing'`,
    `git log origin/${MAIN}..HEAD`,
    `git fetch origin ${MAIN}`,
    `git checkout ${MAIN}`,
  ]) {
    assert.equal(run(cmd), 0, `should have been allowed: ${cmd}`);
  }
});

test('still blocks a hard reset while on main', () => {
  // Branch-aware: only fires when the CWD is actually on main, which it is for this test run.
  const onMain = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
  const expected = /^(main|master)$/.test(onMain) ? 2 : 0;
  assert.equal(run('git reset --hard origin'), expected);
});

test('ignores tools other than Bash', () => {
  assert.equal(run(`${PUSH} origin ${MAIN}`, 'Read'), 0);
});
