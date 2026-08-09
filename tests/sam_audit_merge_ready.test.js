// sam_audit_merge_ready.test.js — the merge-ready ping must not assert what it did not check (#295).
//
// The old step posted "Sam approved. Tests passing. **Ready to merge**" from a condition that
// read Sam's own verdict and nothing else — no test check, no rollup. It was observed on PR #294
// telling a human to `/merge` while a required check was red.
//
// As with the linked-issue gate, the interesting cases are the ones where the honest answer is
// "no": a failing check, a pending check, and an unreadable rollup. A green PR proves nothing
// here — the buggy version got that case right by accident, every time.
//
// The script is extracted from the shipped workflow and compiled the way actions/github-script
// compiles it, so there is one copy of this logic and the test exercises the real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractBlockScalars } from '../tools/workflow-lint.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = join(HERE, '..', '.github', 'workflows', 'sam-audit.yml');
const workflowText = readFileSync(WORKFLOW, 'utf8');

const SELF_NAME = 'Security Audit (Sam CSO)';
const SHA = 'abcdef1234567890';

function pingScriptSource() {
  const blocks = extractBlockScalars(workflowText).filter(b => b.key === 'script');
  const match = blocks.filter(b => b.body.includes('const SELF'));
  assert.equal(match.length, 1, `expected exactly one merge-ready ping script, found ${match.length}`);
  return match[0].body;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const compiled = new AsyncFunction('github', 'context', 'core', pingScriptSource());

const run_ = (name, id, conclusion, status = 'completed') => ({ name, id, status, conclusion });

/**
 * @param {object} opts
 * @param {Array} [opts.checkRuns]  check runs on the head SHA
 * @param {Array} [opts.statuses]   legacy commit statuses
 * @param {Error} [opts.throws]     make the rollup read fail
 */
async function post({ checkRuns = [], statuses = [], throws = null }) {
  const warnings = [];
  const posted = [];
  const core = { warning: m => warnings.push(String(m)), info: () => {}, setOutput: () => {} };
  const context = {
    repo: { owner: 'Zene8', repo: 'AgentSystem' },
    payload: { pull_request: { number: 294, head: { sha: SHA } } },
  };
  const listForRef = async ({ ref }) => {
    if (throws) throw throws;
    assert.equal(ref, SHA, 'the rollup must be read for the PR head SHA, not the default branch');
    return checkRuns;
  };
  const github = {
    paginate: async (fn, params) => fn(params),
    rest: {
      checks: { listForRef },
      repos: {
        getCombinedStatusForRef: async () => {
          if (throws) throw throws;
          return { data: { statuses } };
        },
      },
      issues: { createComment: async (args) => { posted.push(args); } },
    },
  };
  await compiled(github, context, core);
  assert.equal(posted.length, 1, 'exactly one comment must be posted');
  return { body: posted[0].body, warnings, args: posted[0] };
}

// "Ready to merge" as an assertion, not as a substring of "Not ready to merge".
const claimsReady = body => /\*\*Ready to merge\*\*/.test(body) && /reply `\/merge`/.test(body);

// ── The cases the old step got wrong ──────────────────────────────────────────────────────────

test('a failing check means the ping does NOT say ready to merge', async () => {
  const { body } = await post({
    checkRuns: [
      run_('PR must be linked to an issue', 2, 'failure'),
      run_('test', 3, 'success'),
    ],
  });
  assert.equal(claimsReady(body), false, 'must not invite /merge while a check is red');
  assert.match(body, /Not ready to merge/);
  assert.match(body, /PR must be linked to an issue/, 'the failing check must be named');
  assert.match(body, /Sam \(CSO\) approved/, 'the audit verdict is still reported — it is true');
});

test('a still-running check means the ping does NOT say ready to merge', async () => {
  const { body } = await post({
    checkRuns: [run_('test', 4, null, 'in_progress'), run_('workflow-lint', 5, 'success')],
  });
  assert.equal(claimsReady(body), false);
  assert.match(body, /still running/);
  assert.match(body, /`test`/);
});

test('an unreadable rollup reports only what the step knows', async () => {
  const { body, warnings } = await post({ throws: new Error('HTTP 403: rate limited') });
  assert.equal(claimsReady(body), false, 'unknown is not the same as green');
  assert.match(body, /Could not read the check rollup/);
  assert.match(body, /Sam \(CSO\) approved/);
  assert.ok(warnings.some(w => /check rollup/.test(w)), 'a degraded read must be logged');
});

test('a check cancelled on the current attempt counts as not passing', async () => {
  const { body } = await post({ checkRuns: [run_('test', 6, 'cancelled')] });
  assert.equal(claimsReady(body), false);
  assert.match(body, /`test`/);
});

test('a failing LEGACY commit status blocks the ready claim too', async () => {
  const { body } = await post({
    checkRuns: [run_('test', 7, 'success')],
    statuses: [{ context: 'ci/external', state: 'failure' }],
  });
  assert.equal(claimsReady(body), false);
  assert.match(body, /ci\/external/);
});

// ── The cases it must not get wrong in the other direction ────────────────────────────────────

test('all other checks green says ready to merge and offers /merge', async () => {
  const { body } = await post({
    checkRuns: [run_('test', 8, 'success'), run_('workflow-lint', 9, 'success')],
  });
  assert.equal(claimsReady(body), true);
  assert.match(body, /abcdef1/, 'the claim is scoped to a specific commit');
});

test("the job's own in-progress check run is excluded", async () => {
  // It is the thing posting the comment. Counting it would make every ping say a check is still
  // running — about itself — and nothing would ever read as ready.
  const { body } = await post({
    checkRuns: [run_(SELF_NAME, 10, null, 'in_progress'), run_('test', 11, 'success')],
  });
  assert.equal(claimsReady(body), true);
});

test('a superseded older attempt does not veto the newest result', async () => {
  const { body } = await post({
    checkRuns: [run_('test', 12, 'cancelled'), run_('test', 13, 'success')],
  });
  assert.equal(claimsReady(body), true);
});

test('skipped and neutral conclusions count as satisfied', async () => {
  // GitHub itself treats both as satisfying a required check (#228). Calling them failures here
  // would contradict the merge button — wrong in the opposite direction, but still wrong.
  const { body } = await post({
    checkRuns: [run_('docs-only', 14, 'skipped'), run_('advisory', 15, 'neutral')],
  });
  assert.equal(claimsReady(body), true);
});

// ── Static guards ─────────────────────────────────────────────────────────────────────────────

test('the SELF constant matches the job name GitHub will use', () => {
  // GitHub names the check run after the job's `name:`. If they drift, the exclusion stops
  // matching and every ping reports the audit as a pending check against itself.
  assert.match(workflowText, /^\s+name:\s*Security Audit \(Sam CSO\)\s*$/m);
  assert.ok(pingScriptSource().includes(`'${SELF_NAME}'`));
});

test('the unconditional "Tests passing" claim is gone', () => {
  // Asserted as a boolean rather than with doesNotMatch(workflowText, …): a failure there dumps
  // the entire workflow into the test output and buries the one line that matters.
  assert.equal(
    /Sam approved\. Tests passing\./.test(workflowText), false,
    'sam-audit.yml still contains the fixed "Tests passing" sentence, which asserts a test ' +
    'result the step never read — see #295'
  );
});

test('the job declares the scopes the rollup read needs', () => {
  assert.match(workflowText, /^\s+checks:\s*read\s*$/m);
  assert.match(workflowText, /^\s+statuses:\s*read\s*$/m);
});
