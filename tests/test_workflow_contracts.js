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

test('runner health check ignores abandoned queued runs, so its alert can clear', () => {
  // A third defect of the same shape: the check ran, went green, and could never stop alerting.
  // Indirect detection counted any run queued >10min as proof the runner is offline. GitHub can
  // leave a run permanently `queued` with nothing to cancel — the 2026-08-06 outage stranded three
  // on a branch merged and deleted the same day — so the check reported `state=down` against an
  // online idle runner, the tracking issue could never auto-close, and every daily run commented
  // on it again. The window needs an upper bound: only a recently queued run says anything about
  // the runner now.
  const src = read('runner-health-check.yml');
  const select = src.match(/select\(\s*\.created_at\s*<\s*\$cutoff[^)]*\)/);
  assert.ok(select, 'runner-health-check.yml no longer filters queued runs by created_at — parse is stale');
  assert.match(
    select[0],
    /\.created_at\s*>\s*\$\w+/,
    'runner-health-check.yml counts queued runs with no upper age bound. A run GitHub left queued ' +
      'days ago on a deleted branch then pins state=down forever and the runner:down issue can ' +
      'never auto-close.'
  );
  assert.match(
    src,
    /--arg\s+\w+\s+"\$\(date -u -d '-\d+ hours?' \+%Y-%m-%dT%H:%M:%SZ\)"/,
    'the upper bound must come from a jq --arg holding a real timestamp, or the select above ' +
      'compares against an undefined variable and silently matches nothing.'
  );
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
