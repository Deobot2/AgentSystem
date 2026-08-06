// Repo default_workflow_permissions is `read` (see
// `gh api repos/:owner/:repo/actions/permissions/workflow`). A job that writes to
// the API without declaring `permissions:` therefore 403s with "Resource not
// accessible by integration" — a red X that looks like a code failure but is not.
// agent-dispatch.yml shipped with no permissions block at all, so all three of its
// jobs were broken this way. This test fails the build if it happens again.

import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');

// Write operations, mapped to the token scope each one needs.
const WRITE_PATTERNS = [
  [/\bissues\.createComment\b/, 'pull-requests'], // works for both issues and PRs
  [/\bissues\.addLabels\b/, 'issues'],
  [/\bissues\.removeLabel\b/, 'issues'],
  [/\bissues\.create\b/, 'issues'],
  [/\bissues\.update\b/, 'issues'],
  [/\bpulls\.create\b/, 'pull-requests'],
  [/\bpulls\.createReview\b/, 'pull-requests'],
  // CLI writes must be anchored to the start of a line: `gh pr merge` also appears
  // inside prompt text handed to an agent, which runs on the host's own gh
  // credential and needs nothing from GITHUB_TOKEN.
  [/^\s*gh pr (?:comment|edit|review|ready|close)\b/m, 'pull-requests'],
  [/^\s*gh issue (?:create|comment|edit|close|reopen)\b/m, 'issues'],
  [/^\s*gh pr merge\b/m, 'contents'],
  [/^\s*git push\b/m, 'contents'],
];

/**
 * Split a workflow file into its jobs. Jobs are the 2-space-indented keys under
 * the top-level `jobs:` mapping. A regex is enough here — these files are
 * hand-written with consistent indentation and `tools/**` may not add a YAML dep.
 * @param {string} text
 * @returns {Array<{id: string, body: string, line: number}>}
 */
function splitJobs(text) {
  const lines = text.split('\n');
  const start = lines.findIndex(l => /^jobs:\s*$/.test(l));
  if (start === -1) return [];
  const jobs = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (!m) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\S/.test(lines[j]) || /^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[j])) { end = j; break; }
    }
    jobs.push({ id: m[1], body: lines.slice(i, end).join('\n'), line: i + 1 });
  }
  return jobs;
}

/**
 * Scopes granted write access by a job's own `permissions:` block, plus whether
 * the block exists at all. Job-level blocks override workflow-level ones
 * entirely, so a job with its own block must be self-sufficient.
 * @param {string} jobBody
 * @param {string} workflowLevel  the workflow-level permissions block, or ''
 */
function grantedScopes(jobBody, workflowLevel) {
  const own = /^ {4}permissions:\s*$/m.test(jobBody);
  const block = own ? jobBody.slice(jobBody.search(/^ {4}permissions:\s*$/m)) : workflowLevel;
  if (!block) return { declared: false, scopes: new Set() };
  const scopes = new Set();
  // Trailing `# why` comments on a scope line are normal YAML and worth keeping — the regex has to
  // tolerate them, or a well-documented block reads as granting nothing.
  for (const [, scope] of block.matchAll(/^\s{2,}([a-z-]+):\s*write\s*(?:#.*)?$/gm)) scopes.add(scope);
  if (/^\s*permissions:\s*write-all\s*$/m.test(block)) return { declared: true, scopes: null };
  return { declared: true, scopes };
}

function workflowLevelBlock(text) {
  const lines = text.split('\n');
  const i = lines.findIndex(l => /^permissions:/.test(l));
  if (i === -1) return '';
  if (/^permissions:\s*\S/.test(lines[i])) return lines[i];
  let end = lines.length;
  for (let j = i + 1; j < lines.length; j++) {
    if (/^\S/.test(lines[j])) { end = j; break; }
  }
  return lines.slice(i, end).join('\n');
}

const files = readdirSync(WORKFLOW_DIR).filter(f => /\.ya?ml$/.test(f));

test('workflow files exist to check', () => {
  assert.ok(files.length > 0, `no workflows found in ${WORKFLOW_DIR}`);
});

for (const file of files) {
  test(`${file}: every writing job declares the permissions it needs`, () => {
    const text = readFileSync(join(WORKFLOW_DIR, file), 'utf8');
    const wfLevel = workflowLevelBlock(text);
    const problems = [];

    for (const job of splitJobs(text)) {
      const needed = new Set();
      for (const [pattern, scope] of WRITE_PATTERNS) {
        if (pattern.test(job.body)) needed.add(scope);
      }
      if (!needed.size) continue;

      const { declared, scopes } = grantedScopes(job.body, wfLevel);
      if (!declared) {
        problems.push(`${file}:${job.line} job "${job.id}" writes (${[...needed].join(', ')}) but declares no permissions: block`);
        continue;
      }
      if (scopes === null) continue; // write-all
      const missing = [...needed].filter(s => !scopes.has(s));
      if (missing.length) {
        problems.push(`${file}:${job.line} job "${job.id}" needs ${missing.map(s => `${s}: write`).join(', ')}`);
      }
    }

    assert.deepStrictEqual(problems, [], `\n${problems.join('\n')}\n`);
  });
}
