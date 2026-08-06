// Workflow defects of the shape that costs real runs: the workflow is syntactically valid, goes
// green, and does nothing.
//
//   1. ci-failure-notify.yml said `workflow_run.workflows: [test.yml]`. That key matches a
//      workflow's `name:`, not its filename, so it matched nothing and the notifier never fired
//      once. Nothing failed — there was simply never a run.
//   2. scheduled-tasks.yml's daily-triage held `issues: write` alone, so the job committed and
//      tested two branches, could push neither, and reported success (#243).
//
// Per-job GITHUB_TOKEN scopes are covered by tests/workflow_permissions.test.js, which checks each
// job against the specific writes it makes rather than checking the file has a block at all.
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
