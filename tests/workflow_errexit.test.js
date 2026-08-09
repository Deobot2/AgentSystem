// GitHub Actions invokes every `shell: bash` step as:
//
//     bash --noprofile --norc -e -o pipefail {0}
//
// The `-e` comes from the invocation, not from the script, and a step's own `set -uo pipefail`
// does NOT clear it — only `set +e` does. So a step that opens with `set -uo pipefail` and then
// captures a command substitution is one nonzero exit away from dying on that line, with every
// later line silently skipped.
//
// This is not hypothetical. scheduled-tasks.yml's daily-triage step ran `claude ... | tee "$log"`
// under exactly that combination, so when the model exited nonzero the pipeline failed, errexit
// killed the step immediately, and the `rc` capture, the transient-vs-deterministic branch, the
// #234 retry loop and `TRIAGE_LAST_ERROR` never ran once in production. The 2026-08-08 13:00 run
// completed its actual work and still went red with none of its own diagnostics in the log.
// daily-triage-watchdog.yml carried the same shape at its `conclusion=$(gh api ... | head -1)`
// capture (#260) — the watchdog for a dead daily-triage, able to die the same silent way.
//
// The test in #234 missed this because it ran the extracted step under a plain `bash script` with
// no `-e`, which is the one environment where the bug cannot reproduce. So the check below runs
// under the real flags, and carries a negative control proving it fails against the old flag line.
//
// Regex rather than a YAML parser: tools/** and tests/** take no npm deps (CLAUDE.md).

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WF_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');

// Steps that capture command substitutions and must survive a nonzero one to reach their own
// error handling. Each entry is [workflow file, step name as written in `- name:`].
const GUARDED_STEPS = [
  ['scheduled-tasks.yml', 'Run Life OS daily triage (Jarvis)'],
  ['daily-triage-watchdog.yml', 'Did a daily-triage job succeed today?'],
];

// Pull the body of a step's `run: |` block: everything indented past the block's own margin.
function extractRun(file, stepName) {
  // Normalise CRLF: on a Windows checkout with core.autocrlf=true these files land with \r\n, and
  // every `\n`-anchored match below (`run: \|\n`, the body split) silently misses. The step is
  // fine; only the parse was platform-dependent.
  const src = fs.readFileSync(path.join(WF_DIR, file), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf(`- name: ${stepName}`);
  assert.notStrictEqual(start, -1, `${file}: no step named "${stepName}" — the parse is stale`);
  const rest = src.slice(start);
  const run = rest.match(/\n(\s+)run: \|\n/);
  assert.ok(run, `${file}: step "${stepName}" has no \`run: |\` block`);
  const bodyIndent = run[1].length + 2;
  const lines = rest.slice(run.index + run[0].length).split('\n');
  const body = [];
  for (const line of lines) {
    if (line.trim() === '') { body.push(''); continue; }
    if (line.search(/\S/) < bodyIndent) break;
    body.push(line.slice(bodyIndent));
  }
  return body.join('\n');
}

// The first thing the step actually executes, ignoring comments and blank lines.
function firstCommand(body) {
  return body.split('\n').find((l) => l.trim() !== '' && !l.trim().startsWith('#'));
}

for (const [file, stepName] of GUARDED_STEPS) {
  test(`${file}: "${stepName}" clears the errexit it inherits from Actions`, () => {
    const first = firstCommand(extractRun(file, stepName));
    assert.match(
      first ?? '',
      /^set \+e\b/,
      `${file}: step "${stepName}" opens with \`${first}\`. Actions runs it as \`bash -e -o ` +
        `pipefail\`, and only \`set +e\` clears that inherited \`-e\` — \`set -uo pipefail\` does ` +
        `not. Without it the step dies at its first failing command substitution and every line ` +
        `after it, including its own error handling, is dead code.`
    );
  });
}

// Proof that the flag line is what decides this, run the way Actions runs it. The negative control
// is the point: it pins that the old flag line really does lose the sentinel, so this test cannot
// quietly pass against a regression.
test('under Actions flags, only `set +e` lets a step outlive a failing command substitution', () => {
  const underActionsFlags = (flags) =>
    spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
      `${flags}\nvalue=$(false | head -1)\necho "reached-the-end rc=$?"`], { encoding: 'utf8' });

  const fixed = underActionsFlags('set +e -uo pipefail');
  assert.match(
    fixed.stdout,
    /reached-the-end/,
    '`set +e -uo pipefail` should let the step continue past a failed capture and decide for itself'
  );

  const old = underActionsFlags('set -uo pipefail');
  assert.doesNotMatch(
    old.stdout,
    /reached-the-end/,
    '`set -uo pipefail` must still lose the line after a failed capture — if this stops being ' +
      'true, bash or the harness changed and the test above is no longer testing anything'
  );
  assert.notStrictEqual(old.status, 0, 'the old flag line should exit nonzero at the failed capture');
});
