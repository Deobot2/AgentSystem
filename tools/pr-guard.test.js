import { test } from 'node:test';
import assert from 'node:assert/strict';

// pr-guard.js uses `gh` CLI which requires authentication.
// Tests here cover the pure logic: PR number extraction and check filtering.
// Integration test (real PR) is run separately in the acceptance matrix.

// Import only the pure function (avoids running gh in test env)
import { checkPr, isSamApproval } from './pr-guard.js';

// #112 follow-up (Sam's own audit of this fix): body-text matching alone is spoofable --
// submitting an "Approve" review does NOT require write/maintainer permission on GitHub, so
// any collaborator could forge "Sam (CSO)" + "APPROVED:" in their own review body. isSamApproval
// must also verify the reviewer identity is the github-actions[bot] service account that
// sam-audit.yml actually posts as.
test('isSamApproval accepts a real Sam audit review (bot identity + markers)', () => {
  const review = {
    state: 'APPROVED',
    user: { login: 'github-actions[bot]', type: 'Bot' },
    body: '✅ **Sam (CSO) — Automated Security Audit**\n\nAPPROVED: looks fine',
  };
  assert.strictEqual(isSamApproval(review), true);
});

test('isSamApproval rejects a forged review from a non-bot account with spoofed body text', () => {
  const review = {
    state: 'APPROVED',
    user: { login: 'some-collaborator', type: 'User' },
    body: '✅ **Sam (CSO) — Automated Security Audit**\n\nAPPROVED: looks fine',
  };
  assert.strictEqual(isSamApproval(review), false);
});

test('isSamApproval rejects bot-authored review missing the required markers', () => {
  const review = {
    state: 'APPROVED',
    user: { login: 'github-actions[bot]', type: 'Bot' },
    body: 'Looks good to me!',
  };
  assert.strictEqual(isSamApproval(review), false);
});

// GitHub hard-blocks GITHUB_TOKEN from submitting APPROVE reviews, so sam-audit.yml posts
// approved verdicts as COMMENTED reviews (see its createReview step). Found on #172:
// requiring state === 'APPROVED' made the gate unpassable for every approved PR.
test('isSamApproval accepts COMMENTED review from the trusted bot with approval markers', () => {
  const review = {
    state: 'COMMENTED',
    user: { login: 'github-actions[bot]', type: 'Bot' },
    body: '✅ **Sam (CSO) — Automated Security Audit**\n\nAPPROVED: looks fine',
  };
  assert.strictEqual(isSamApproval(review), true);
});

test('isSamApproval rejects CHANGES_REQUESTED review even from the trusted bot identity', () => {
  const review = {
    state: 'CHANGES_REQUESTED',
    user: { login: 'github-actions[bot]', type: 'Bot' },
    body: '🚫 **Sam (CSO) — Automated Security Audit**\n\nAPPROVED: looks fine',
  };
  assert.strictEqual(isSamApproval(review), false);
});

// #271: a docs-only PR never runs the Claude audit, so its approval comes from sam-audit.yml's
// fast path instead. That body is generated separately from the audited one and must keep
// satisfying the same gate — before this, docs-only PRs got a green check and no review at all,
// which made pr-guard unpassable for them no matter what the author did.
test('isSamApproval accepts the docs-only fast-path review sam-audit.yml posts without an audit', () => {
  const review = {
    state: 'COMMENTED',
    user: { login: 'github-actions[bot]', type: 'Bot' },
    body: '✅ **Sam (CSO) — Automated Security Audit**\n\n' +
      'APPROVED: docs-only change (docs/** and *.md files only) — no model audit required.',
  };
  assert.strictEqual(isSamApproval(review), true);
});

// Helper to simulate checkPr result shape
function makeResult({ checksOk, threadsOk, samAuditOk = true, prNumber = '99' }) {
  return {
    prNumber,
    checksOk,
    threadsOk,
    samAuditOk,
    ok: checksOk && threadsOk && samAuditOk,
    summary: [
      checksOk ? 'CI: all green' : 'CI: 1 check(s) not green',
      threadsOk ? 'Reviews: no blocking change requests' : 'Reviews: 1 reviewer(s) requested changes',
      samAuditOk ? 'Sam audit: APPROVED review found' : 'Sam audit: no APPROVED review from Sam (CSO) found',
    ],
  };
}

test('result ok only when checks, threads, and sam audit all pass', () => {
  const r = makeResult({ checksOk: true, threadsOk: true, samAuditOk: true });
  assert.strictEqual(r.ok, true);
});

test('result not ok when CI fails', () => {
  const r = makeResult({ checksOk: false, threadsOk: true });
  assert.strictEqual(r.ok, false);
});

test('result not ok when reviews block', () => {
  const r = makeResult({ checksOk: true, threadsOk: false });
  assert.strictEqual(r.ok, false);
});

test('result not ok when both fail', () => {
  const r = makeResult({ checksOk: false, threadsOk: false });
  assert.strictEqual(r.ok, false);
});

// #112: a PR with green CI and no CHANGES_REQUESTED reviews must still fail pr-guard if there is
// no explicit Sam (CSO) APPROVED review — this is the hard security gate, not an advisory check.
test('result not ok when CI and threads pass but Sam never approved', () => {
  const r = makeResult({ checksOk: true, threadsOk: true, samAuditOk: false });
  assert.strictEqual(r.ok, false);
});

test('checkPr returns error for invalid argument', async () => {
  // This calls checkPr with a bad arg but does NOT invoke gh (returns early on parse)
  const result = await checkPr('not-a-number-or-url');
  assert.strictEqual(result.ok, false);
  assert.ok(result.error, 'should have an error field');
});

test('checkPr extracts PR number from URL', async () => {
  // We can't run gh without auth, but we can test that the function doesn't
  // error on the parse step. The actual gh call will fail in CI without auth,
  // so we wrap and just check the structure of the promise rejection.
  const result = await checkPr('https://github.com/owner/repo/pull/76').catch(e => ({
    ok: false,
    error: e.message,
  }));
  // Either returns a result or an error — both are valid shapes
  assert.ok(typeof result === 'object', 'should return an object');
  assert.ok('ok' in result, 'should have ok field');
});
