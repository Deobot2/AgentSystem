// Two workflow defects that cost real runs, both of the same shape: the workflow was syntactically
// valid, went green, and did nothing.
//
//   1. ci-failure-notify.yml said `workflow_run.workflows: [test.yml]`. That key matches a
//      workflow's `name:`, not its filename, so it matched nothing and the notifier never fired
//      once. Nothing failed — there was simply never a run.
//   2. agent-dispatch.yml declared no `permissions:`, so its default GITHUB_TOKEN was read-only and
//      `ambient-sam-review` 403'd on the comment it exists to post, after paying for the scan.
//
// Regex rather than a YAML parser on purpose: tools/** and tests/** take no npm deps (CLAUDE.md),
// and both defects live in single lines that a regex reads exactly as well.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WF_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');
const files = fs.readdirSync(WF_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
const read = (f) => fs.readFileSync(path.join(WF_DIR, f), 'utf8');

// Strip `#` comments so prose that merely mentions a pattern is not mistaken for a call. Only
// whole-line comments: a `#` inside a run: script can be meaningful shell.
const stripComments = (src) =>
  src
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

test('workflow_run.workflows entries match a real workflow name, not a filename', () => {
  const names = new Set(
    files
      .map((f) => read(f).match(/^name:\s*(.+?)\s*$/m))
      .filter(Boolean)
      .map((m) => m[1].replace(/^['"]|['"]$/g, ''))
  );
  assert.ok(names.size > 0, 'no workflow declared a name: — the parse is wrong, not the workflows');

  for (const f of files) {
    // `workflows: [A, B]` — the inline form this repo uses.
    for (const m of read(f).matchAll(/^\s*workflows:\s*\[([^\]]*)\]/gm)) {
      for (const raw of m[1].split(',')) {
        const ref = raw.trim().replace(/^['"]|['"]$/g, '');
        if (!ref) continue;
        assert.ok(
          !/\.ya?ml$/i.test(ref),
          `${f}: workflow_run.workflows: [${ref}] is a FILENAME. This key matches a workflow's ` +
            `name:, so it silently matches nothing and the workflow never triggers.`
        );
        assert.ok(
          names.has(ref),
          `${f}: workflow_run.workflows: [${ref}] matches no workflow name:. ` +
            `Known names: ${[...names].sort().join(', ')}`
        );
      }
    }
  }
});

test('a workflow that writes to an issue or PR declares permissions', () => {
  // Each pattern needs a GITHUB_TOKEN scope beyond the read-only default.
  const WRITES = [
    /issues\.createComment/,
    /issues\.addLabels/,
    /issues\.removeLabel/,
    /issues\.update\b/,
    /pulls\.create\b/,
    /\bgh pr comment\b/,
    /\bgh pr merge\b/,
    /\bgh pr edit\b/,
    /\bgh pr create\b/,
    /\bgh issue comment\b/,
    /\bgh issue create\b/,
  ];

  for (const f of files) {
    const src = stripComments(read(f));
    const hit = WRITES.find((re) => re.test(src));
    if (!hit) continue;
    assert.match(
      src,
      /^\s*permissions:\s*$/m,
      `${f} writes to an issue or PR (matched ${hit}) but declares no permissions:. ` +
        `The default GITHUB_TOKEN is read-only, so that call fails with 403 ` +
        `"Resource not accessible by integration" at runtime — after the job has done its work.`
    );
  }
});

test('daily-triage can push a branch and open the PR it is specified to produce', () => {
  // Stage 2's whole output is draft PRs. `issues: write` alone let the job finish "successfully"
  // with its committed branches stranded and unpushed (#243).
  const src = read('scheduled-tasks.yml');
  const job = src.slice(src.indexOf('\n  daily-triage:'));
  const block = job.slice(0, job.indexOf('\n    env:'));
  for (const scope of ['issues: write', 'contents: write', 'pull-requests: write']) {
    assert.ok(
      block.includes(scope),
      `scheduled-tasks.yml daily-triage is missing '${scope}'. Without contents+pull-requests the ` +
        `run cannot push a branch or open a PR, and silently strands its work (#243).`
    );
  }
});
