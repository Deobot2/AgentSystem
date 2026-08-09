import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, DEFAULT_GRACE_MINUTES } from './pr-checks-watchdog.js';

const NOW = new Date('2026-08-09T10:00:00Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

// The real branch-protection contexts on `main`, from
//   gh api repos/{owner}/{repo}/branches/main/protection/required_status_checks
const REQUIRED = ['Node.js tests', 'Security Audit (Sam CSO)', 'PR must be linked to an issue'];

const pr = (over = {}) => ({
  number: 1,
  url: 'https://github.com/Zene8/AgentSystem/pull/1',
  title: 'a pull request',
  isDraft: false,
  createdAt: minutesAgo(90),
  checkNames: REQUIRED,
  ...over,
});

test('PR #326: a conflicting PR whose only check run is GitGuardian is caught', () => {
  // The regression. #326 was open against main with exactly one check run — the GitGuardian app,
  // which is a GitHub App webhook and fires without a merge ref. None of the repo's own required
  // contexts ran, because GitHub dispatches no `pull_request` events for a conflicting PR.
  const v = decide({
    prs: [pr({ number: 326, checkNames: ['GitGuardian Security Checks'] })],
    requiredContexts: REQUIRED,
    now: NOW,
  });
  assert.equal(v.unchecked.length, 1);
  assert.equal(v.unchecked[0].number, 326);
  assert.match(v.reason, /#326/);
});

test('a PR with zero check runs at all is caught', () => {
  const v = decide({ prs: [pr({ checkNames: [] })], requiredContexts: REQUIRED, now: NOW });
  assert.equal(v.unchecked.length, 1);
});

test('a healthy PR with all required checks is quiet', () => {
  assert.equal(decide({ prs: [pr()], requiredContexts: REQUIRED, now: NOW }).unchecked.length, 0);
});

test('partial coverage is NOT an alert — branch protection already blocks that merge', () => {
  // A PR missing only some required contexts is visibly BLOCKED and GitHub refuses the merge.
  // Alerting here would also fire on any check still in flight, which looks identical from the
  // API to one that never dispatched. Only the total no-show is invisible.
  const v = decide({
    prs: [pr({ checkNames: ['Node.js tests', 'PR must be linked to an issue'] })],
    requiredContexts: REQUIRED,
    now: NOW,
  });
  assert.equal(v.unchecked.length, 0);
});

test('one required context present is enough to stay quiet', () => {
  const v = decide({
    prs: [pr({ checkNames: ['Node.js tests', 'GitGuardian Security Checks'] })],
    requiredContexts: REQUIRED,
    now: NOW,
  });
  assert.equal(v.unchecked.length, 0);
});

test('a just-opened PR is inside the grace window and does not false-alarm', () => {
  const v = decide({
    prs: [pr({ createdAt: minutesAgo(2), checkNames: [] })],
    requiredContexts: REQUIRED,
    now: NOW,
  });
  assert.equal(v.unchecked.length, 0);
});

test('the same PR does alert once it is past the grace window', () => {
  const v = decide({
    prs: [pr({ createdAt: minutesAgo(DEFAULT_GRACE_MINUTES + 1), checkNames: [] })],
    requiredContexts: REQUIRED,
    now: NOW,
  });
  assert.equal(v.unchecked.length, 1);
});

test('unreadable branch protection stays quiet instead of flagging every PR', () => {
  assert.equal(decide({ prs: [pr({ checkNames: [] })], requiredContexts: [], now: NOW }).unchecked.length, 0);
});

test('an unparseable createdAt does not crash or alert', () => {
  const v = decide({ prs: [pr({ createdAt: 'not-a-date', checkNames: [] })], requiredContexts: REQUIRED, now: NOW });
  assert.equal(v.unchecked.length, 0);
});

test('reports every unchecked PR, not just the first', () => {
  const v = decide({
    prs: [pr({ number: 326, checkNames: [] }), pr({ number: 331, checkNames: [] }), pr()],
    requiredContexts: REQUIRED,
    now: NOW,
  });
  assert.deepEqual(v.unchecked.map((p) => p.number), [326, 331]);
});
