// Runs the retry loop that scheduled-tasks.yml actually ships, rather than a copy of it.
// The step's `run:` block is extracted from the workflow at test time and executed against a
// stubbed `claude`, so the test cannot drift away from the thing it is checking. #234.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(repoRoot, '.github/workflows/scheduled-tasks.yml');
const STEP = '- name: Run Life OS daily triage (Jarvis)';

// No YAML parser here on purpose: tools and tests are Node-builtins only, and the block is
// unambiguous — everything indented past `run: |` until the indentation drops back.
function extractRunBlock() {
  const lines = readFileSync(WORKFLOW, 'utf8').split('\n');
  const stepAt = lines.findIndex((l) => l.trim() === STEP);
  assert.notEqual(stepAt, -1, `step not found in ${WORKFLOW} — was it renamed?`);
  const runAt = lines.findIndex((l, i) => i > stepAt && l.trim() === 'run: |');
  assert.notEqual(runAt, -1, 'no `run: |` after the step');

  const body = [];
  const indent = lines[runAt].search(/\S/) + 2;
  for (let i = runAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== '' && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  const script = body.join('\n');
  assert.match(script, /attempts=3/, 'extracted the wrong block — no retry loop in it');
  return script;
}

// plan is one outcome per invocation: 'ok' | '529' | 'badagent'
function runStep(plan) {
  const dir = mkdtempSync(join(tmpdir(), 'triage-retry-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);

  writeFileSync(
    join(bin, 'claude'),
    `#!/bin/sh
n=$(cat "$STUB_COUNT" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$STUB_COUNT"
case "$(echo "$STUB_PLAN" | cut -d, -f"$n")" in
  ok)       echo "daily triage complete"; exit 0 ;;
  529)      echo "API Error: 529 Overloaded. This is a server-side issue, usually temporary"; exit 1 ;;
  badagent) echo "Error: --agent 'jarvis' not found"; exit 1 ;;
esac
echo "stub ran more times than the plan allows"; exit 99
`,
    { mode: 0o755 },
  );
  // Real backoff is 60s + 300s. The test asserts the loop's decisions, not the clock.
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(join(bin, 'claude'), 0o755);

  const script = join(dir, 'step.sh');
  writeFileSync(script, extractRunBlock());
  const githubEnv = join(dir, 'github_env');
  writeFileSync(githubEnv, '');
  writeFileSync(join(dir, 'count'), '0');

  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        STUB_PLAN: plan,
        STUB_COUNT: join(dir, 'count'),
        RUNNER_TEMP: dir,
        GITHUB_ENV: githubEnv,
        REPO: repoRoot,
        LIFE_REPO: dir,
      },
    });
  } catch (err) {
    status = err.status;
    stdout = `${err.stdout || ''}${err.stderr || ''}`;
  }

  const exported = Object.fromEntries(
    readFileSync(githubEnv, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { status, stdout, exported, calls: Number(readFileSync(join(dir, 'count'), 'utf8').trim()) };
}

test('a 529 is retried and the run still succeeds', () => {
  const r = runStep('529,529,ok');
  assert.equal(r.status, 0);
  assert.equal(r.calls, 3, 'should have retried twice before succeeding');
  assert.equal(r.exported.TRIAGE_ATTEMPTS, '3');
});

test('a non-transient error fails immediately without burning the window', () => {
  const r = runStep('badagent,ok,ok');
  assert.notEqual(r.status, 0);
  assert.equal(r.calls, 1, 'a bad agent name is deterministic — retrying it is wasted time');
  assert.match(r.stdout, /non-transient/);
  assert.equal(r.exported.TRIAGE_ATTEMPTS, '1');
});

test('three straight 529s give up and report the real cause to the alert', () => {
  const r = runStep('529,529,529');
  assert.notEqual(r.status, 0);
  assert.equal(r.calls, 3, 'exactly the attempt budget, no more');
  assert.equal(r.exported.TRIAGE_ATTEMPTS, '3', 'must be tries made, not one past the loop');
  assert.match(r.exported.TRIAGE_LAST_ERROR, /529/);
});
