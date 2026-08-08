// #gh-token-shadow: the daily-triage job used to set job-level `GH_TOKEN:
// ${{ secrets.GITHUB_TOKEN }}`. `gh` treats a GH_TOKEN env var as an absolute
// override that wins even over a fully-authenticated `hosts.yml` entry, and
// `gh auth switch` cannot undo that at runtime. Measured on the runner: with
// GH_TOKEN set, every `gh` write in this job authenticated as
// `github-actions[bot]`, whose permissions on this repo are
// {admin:false, maintain:false, pull:false, push:false, triage:false} — so
// `gh pr create` (and every other `gh` write) 403s, even though `git push`
// works fine (this job has no `actions/checkout` step to wire GH_TOKEN into
// git's credential helper, so git was never affected).
//
// The fix is to NOT set a job-level GH_TOKEN at all, so `gh` falls through to
// the self-hosted runner's own `hosts.yml` credential — a `repo`-scoped PAT
// that can actually push and open PRs. This test fails on the old config
// (GH_TOKEN set to the permissionless secrets.GITHUB_TOKEN at job level) and
// passes once it is removed.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.github',
  'workflows',
  'scheduled-tasks.yml',
);

/** Slice out the body of a single top-level job (2-space indented key under `jobs:`). */
function extractJobBody(text, jobId) {
  const lines = text.split('\n');
  const start = lines.findIndex(l => new RegExp(`^  ${jobId}:\\s*$`).test(l));
  assert.notStrictEqual(start, -1, `job "${jobId}" not found in ${WORKFLOW_PATH}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/** Slice out a job-level (4-space indented key) mapping block, e.g. `env:`. */
function extractJobLevelBlock(jobBody, key) {
  const lines = jobBody.split('\n');
  const start = lines.findIndex(l => new RegExp(`^ {4}${key}:\\s*$`).test(l));
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    // Mapping entries under a 4-space key sit at 6+ spaces; a line at <=4 spaces
    // (and non-blank) ends the block.
    if (/^\s*$/.test(lines[i])) continue;
    if (!/^ {6,}/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

test('daily-triage job does not shadow the runner PAT with the permissionless GITHUB_TOKEN', () => {
  const text = readFileSync(WORKFLOW_PATH, 'utf8');
  const jobBody = extractJobBody(text, 'daily-triage');
  const envBlock = extractJobLevelBlock(jobBody, 'env');

  assert.ok(envBlock, 'daily-triage has no job-level env: block to check');
  assert.doesNotMatch(
    envBlock,
    /^\s*GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}\s*$/m,
    'daily-triage sets job-level GH_TOKEN to secrets.GITHUB_TOKEN, which shadows the ' +
      "self-hosted runner's own gh credential with a token that has no write access on this repo " +
      '(admin:false, maintain:false, pull:false, push:false, triage:false) — every `gh` write ' +
      '(e.g. gh pr create) in this job and in every subagent it spawns will 403.',
  );
});
