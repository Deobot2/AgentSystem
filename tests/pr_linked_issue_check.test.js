// pr_linked_issue_check.test.js — behavioural tests for the linked-issue gate (#296).
//
// The gate is a required status check on `main` with enforce_admins, so both of its failure
// directions are expensive: too strict wedges every merge in the repo, too loose makes the
// traceability it advertises imaginary. Neither direction is provable by watching the check go
// green on a correctly-linked PR — the pre-#296 code, which never called the API at all, passed
// that case too. What distinguishes a real gate from a syntax check is only visible in the
// negative cases, so those are the load-bearing tests here:
//
//   • `Closes #99999` for an issue that does not exist  → MUST fail   (the #296 report)
//   • a branch named `issue-0-whatever`                 → MUST fail
//   • a number that belongs to a pull request           → MUST fail
//   • the issues API returning 403 / 500                → MUST pass   (deadlock avoidance)
//
// The script under test is not a copy. It is extracted from
// `.github/workflows/pr-linked-issue-check.yml` at run time with the same block-scalar reader
// `tools/workflow-lint.js` uses, then compiled the way `actions/github-script` compiles it — as
// the body of an async function, so top-level `await` and `return` are legal. There is therefore
// exactly one copy of this logic, and it is the one that ships. A test against a re-implementation
// would be the same paper-check pattern the gate itself was guilty of.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractBlockScalars } from '../tools/workflow-lint.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = join(HERE, '..', '.github', 'workflows', 'pr-linked-issue-check.yml');
const workflowText = readFileSync(WORKFLOW, 'utf8');

const OWNER = 'Zene8';
const REPO = 'AgentSystem';

// ── Load the shipped script ───────────────────────────────────────────────────────────────────

function checkScriptSource() {
  const blocks = extractBlockScalars(workflowText).filter(b => b.key === 'script');
  const match = blocks.filter(b => b.body.includes('addCandidate'));
  assert.equal(
    match.length, 1,
    `expected exactly one script block containing addCandidate, found ${match.length}. ` +
    'If the detection step was renamed or restructured, update this selector — do not delete it.'
  );
  return match[0].body;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const compiled = new AsyncFunction('github', 'context', 'core', checkScriptSource());

/**
 * Run the shipped detection script against a fake PR and a fake issues API.
 *
 * @param {object} opts
 * @param {string} [opts.branch]   head ref
 * @param {string} [opts.body]     PR body
 * @param {string[]} [opts.labels] PR labels
 * @param {(n:number)=>object} opts.issues  resolver: return an issue payload, or throw an error
 *                                          carrying `.status` to simulate an API failure.
 */
async function run({ branch = 'some-branch', body = '', labels = [], issues = () => notFound() }) {
  const outputs = {};
  const warnings = [];
  const requested = [];

  const core = {
    setOutput: (k, v) => { outputs[k] = v; },
    warning: (m) => warnings.push(String(m)),
    info: () => {},
    notice: () => {},
  };
  const context = {
    repo: { owner: OWNER, repo: REPO },
    issue: { number: 1234 },
    payload: {
      pull_request: {
        number: 1234,
        head: { ref: branch },
        body,
        labels: labels.map(name => ({ name })),
      },
    },
  };
  const github = {
    rest: {
      issues: {
        get: async ({ owner, repo, issue_number }) => {
          requested.push({ owner, repo, issue_number });
          return { data: issues(issue_number) };
        },
      },
    },
  };

  await compiled(github, context, core);
  return { outputs, warnings, requested };
}

const httpError = (status, message) => Object.assign(new Error(message), { status });
const notFound = () => { throw httpError(404, 'Not Found'); };
const issue = (n, over = {}) => ({ number: n, state: 'open', title: `issue ${n}`, ...over });

// ── The negative cases — the ones the pre-#296 gate got wrong ─────────────────────────────────

test('body reference to an issue that does not exist FAILS the gate', async () => {
  const { outputs, requested } = await run({
    branch: 'some-branch',
    body: 'Closes #99999',
    issues: notFound,
  });
  assert.equal(outputs.linked, 'false', 'Closes #99999 must not satisfy the gate');
  assert.equal(outputs.exempt, 'false');
  assert.match(outputs.reason, /#99999.*does not exist/);
  assert.deepEqual(requested, [{ owner: OWNER, repo: REPO, issue_number: 99999 }]);
});

test('branch reference to an issue that does not exist FAILS the gate', async () => {
  const { outputs } = await run({ branch: 'issue-99999-whatever', issues: notFound });
  assert.equal(outputs.linked, 'false');
  assert.match(outputs.reason, /#99999.*does not exist/);
});

test('issue #0 is rejected without spending an API call', async () => {
  const { outputs, requested } = await run({
    branch: 'issue-0-whatever',
    issues: () => { throw new Error('must not be called'); },
  });
  assert.equal(outputs.linked, 'false');
  assert.equal(requested.length, 0, '#0 is not a valid issue number — reject before the API call');
});

test('a number belonging to a PULL REQUEST is not a linked issue', async () => {
  const { outputs } = await run({
    body: 'Closes #294',
    // The REST issues endpoint serves PRs too; the `pull_request` key is the discriminator.
    issues: n => issue(n, { pull_request: { url: 'https://api.github.com/…/pulls/294' } }),
  });
  assert.equal(outputs.linked, 'false');
  assert.match(outputs.reason, /#294.*pull request, not an issue/);
});

test('no reference at all fails, with a reason that says so', async () => {
  const { outputs, requested } = await run({ branch: 'feature/whatever', body: 'no link here' });
  assert.equal(outputs.linked, 'false');
  assert.equal(requested.length, 0);
  assert.match(outputs.reason, /No issue reference found/i);
});

test('a cross-repo reference does not resolve against this repo', async () => {
  // `owner/repo#N` must not be read as a local `#N`. If it ever were, the number would be
  // looked up here and could resolve to an unrelated local issue.
  const { outputs, requested } = await run({
    branch: 'feature/x',
    body: 'Closes octocat/other-repo#12',
    issues: () => { throw new Error('must not be called'); },
  });
  assert.equal(outputs.linked, 'false');
  assert.equal(requested.length, 0);
});

// ── The positive cases ────────────────────────────────────────────────────────────────────────

test('branch issue-<N> naming a real open issue passes', async () => {
  const { outputs, requested } = await run({
    branch: 'issue-296-linked-issue-gate',
    issues: n => issue(n),
  });
  assert.equal(outputs.linked, 'true');
  assert.match(outputs.reason, /issue #296 \[open\]/);
  assert.deepEqual(requested, [{ owner: OWNER, repo: REPO, issue_number: 296 }]);
});

test('a CLOSED issue still counts as linked', async () => {
  // Deliberate: the gate enforces that the work is tracked, not that the tracking item is still
  // open. See the long comment in the workflow.
  const { outputs } = await run({ body: 'Fixes #42', issues: n => issue(n, { state: 'closed' }) });
  assert.equal(outputs.linked, 'true');
  assert.match(outputs.reason, /\[closed\]/);
});

test('a stale branch number does not veto a good body reference', async () => {
  const { outputs, requested } = await run({
    branch: 'issue-99999-stale',
    body: 'Closes #42',
    issues: n => (n === 42 ? issue(42) : notFound()),
  });
  assert.equal(outputs.linked, 'true');
  assert.match(outputs.reason, /issue #42/);
  assert.deepEqual(requested.map(r => r.issue_number), [99999, 42]);
});

test('the spec label exempts without touching the API', async () => {
  const { outputs, requested } = await run({
    branch: 'feature/x',
    labels: ['spec'],
    issues: () => { throw new Error('must not be called'); },
  });
  assert.equal(outputs.exempt, 'true');
  assert.equal(outputs.linked, 'false');
  assert.equal(requested.length, 0);
});

// ── Fail-open on infrastructure errors ────────────────────────────────────────────────────────
//
// Required check + enforce_admins: red on a transient API error blocks every merge in the repo
// at once, with no non-admin way out. These tests pin the direction of that trade-off.

for (const [status, label] of [[403, 'rate limit / forbidden'], [500, 'server error'], [502, 'bad gateway'], [410, 'gone']]) {
  test(`API ${status} (${label}) fails OPEN rather than deadlocking merges`, async () => {
    const { outputs, warnings } = await run({
      body: 'Closes #42',
      issues: () => { throw httpError(status, label); },
    });
    assert.equal(outputs.linked, 'true', `HTTP ${status} must not block the merge queue`);
    assert.match(outputs.reason, /UNVERIFIED/);
    assert.ok(
      warnings.some(w => /DEGRADED/.test(w)),
      'a fail-open must be loud — it produces a green check that verified nothing'
    );
  });
}

test('a network error with no status fails open too', async () => {
  const { outputs } = await run({
    body: 'Closes #42',
    issues: () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(outputs.linked, 'true');
  assert.match(outputs.reason, /UNVERIFIED/);
});

test('a definitive 404 alongside an infra error still fails open', async () => {
  // Order matters: one candidate proven absent does not license blocking when another candidate
  // could not be checked at all.
  const { outputs } = await run({
    branch: 'issue-99999-stale',
    body: 'Closes #42',
    issues: n => { if (n === 99999) notFound(); throw httpError(503, 'unavailable'); },
  });
  assert.equal(outputs.linked, 'true');
  assert.match(outputs.reason, /UNVERIFIED/);
});

// ── Static guards ─────────────────────────────────────────────────────────────────────────────

test('the job still declares issues: read', () => {
  // Without this scope `issues.get` errors, the fail-open rule accepts every reference
  // unverified, and the gate quietly degrades to the syntax-only check #296 removed. A dropped
  // line here produces no error anywhere — only a permanently green gate.
  assert.match(
    workflowText,
    /^\s+issues:\s*read\s*$/m,
    'pr-linked-issue-check.yml must grant issues: read — see #296'
  );
});

test('the detection step actually calls the issues API', () => {
  // The whole content of #296: a gate that only pattern-matches strings proves nothing.
  assert.match(checkScriptSource(), /github\.rest\.issues\.get\(/);
});
