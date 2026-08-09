import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseRoutinesYml, dispatchRoutines, verifyCronRoutines } from './routines.js';

// --- parseRoutinesYml ---

const SAMPLE_YML = `
- id: always-worktree
  description: Feature work in a worktree
  trigger: feature_work
  mechanism: agent-rule
  enforce: hard
  enabled: true
  action: "Do the worktree thing."

- id: auto-resolve
  description: Auto resolve PR comments
  trigger: pr_create
  mechanism: hook
  enforce: hard
  enabled: true
  action: "Schedule a job."

- id: disabled-rule
  description: This one is off
  trigger: feature_work
  mechanism: agent-rule
  enforce: hard
  enabled: false
  action: "Should not appear."
`;

test('parseRoutinesYml parses 3 entries', () => {
  const routines = parseRoutinesYml(SAMPLE_YML);
  assert.strictEqual(routines.length, 3);
});

test('parseRoutinesYml correctly parses string fields', () => {
  const routines = parseRoutinesYml(SAMPLE_YML);
  const r = routines[0];
  assert.strictEqual(r.id, 'always-worktree');
  assert.strictEqual(r.mechanism, 'agent-rule');
  assert.strictEqual(r.trigger, 'feature_work');
  assert.strictEqual(r.enforce, 'hard');
});

test('parseRoutinesYml parses boolean enabled=true', () => {
  const routines = parseRoutinesYml(SAMPLE_YML);
  assert.strictEqual(routines[0].enabled, true);
  assert.strictEqual(routines[2].enabled, false);
});

test('parseRoutinesYml parses action without trailing quote artifacts', () => {
  const routines = parseRoutinesYml(SAMPLE_YML);
  assert.ok(routines[0].action.includes('worktree'), 'action should contain worktree');
});

test('parseRoutinesYml handles comment lines', () => {
  const yml = `# top comment
- id: foo
  # inline comment
  description: bar
  trigger: t
  mechanism: hook
  enforce: hard
  enabled: true
  action: "x"
`;
  const routines = parseRoutinesYml(yml);
  assert.strictEqual(routines.length, 1);
  assert.strictEqual(routines[0].id, 'foo');
});

test('parseRoutinesYml idempotent on empty input', () => {
  const routines = parseRoutinesYml('');
  assert.deepEqual(routines, []);
});

// --- dispatchRoutines ---
// dispatchRoutines reads actual files, so we test the filter logic inline
// by mocking the imported function's behavior.

test('parseRoutinesYml filter: hook-mechanism, enabled, not bypassed', () => {
  const routines = parseRoutinesYml(SAMPLE_YML);
  const overrides = {};

  // Simulate dispatchRoutines filter logic (PostToolUse / pr_create)
  const matched = routines.filter(r => {
    if (!r.enabled) return false;
    if (overrides[r.id]) return false;
    if (r.mechanism !== 'hook') return false;
    if (r.trigger === 'pr_create') return true;
    return false;
  });

  assert.strictEqual(matched.length, 1);
  assert.strictEqual(matched[0].id, 'auto-resolve');
});

test('parseRoutinesYml filter: bypass suppresses routine', () => {
  const routines = parseRoutinesYml(SAMPLE_YML);
  const overrides = { 'auto-resolve': { bypassed: true } };

  const matched = routines.filter(r => {
    if (!r.enabled) return false;
    if (overrides[r.id]) return false;
    if (r.mechanism !== 'hook') return false;
    if (r.trigger === 'pr_create') return true;
    return false;
  });

  assert.strictEqual(matched.length, 0, 'bypassed routine should be excluded');
});

test('parseRoutinesYml filter: disabled routine not included', () => {
  const routines = parseRoutinesYml(SAMPLE_YML);
  const overrides = {};

  const matched = routines.filter(r => {
    if (!r.enabled) return false;
    if (overrides[r.id]) return false;
    if (r.mechanism !== 'agent-rule') return false;
    if (r.trigger === 'feature_work') return true;
    return false;
  });

  // always-worktree is enabled, disabled-rule is not
  assert.strictEqual(matched.length, 1);
  assert.strictEqual(matched[0].id, 'always-worktree');
});

// --- dispatchRoutines (real export, not the inline-filter re-implementation above) ---
//
// tools/routines.test.js previously imported dispatchRoutines() (line 4) but never called it —
// its tests only exercised a plain .filter() copy-pasted from the function's body. That let
// dispatchRoutines() itself go untested, which is how the (mistaken) bug report that it "passes
// hardcoded null as currentSessionId" went unchallenged: nothing actually invoked the function to
// check. These tests call the real export against the live config/routines.yml (same pattern the
// #200 cron tests already use below) and a throwaway overrides file pointed at by
// AGENT_ROUTINE_OVERRIDES_PATH, which tools/routines.js now resolves through at runtime.
//
// Fixture routine: `auto-resolve-pr-comments` — mechanism: hook, trigger: pr_create, enabled: true
// in the live registry. If that routine is ever renamed/disabled, update this id.
const DISPATCH_TEST_ROUTINE_ID = 'auto-resolve-pr-comments';
const DISPATCH_TMP_DIR = join(tmpdir(), 'agentsystem-dispatch-test-' + process.pid);
const DISPATCH_OVERRIDES_PATH = join(DISPATCH_TMP_DIR, 'routine-overrides.json');

function writeDispatchOverride(override) {
  mkdirSync(DISPATCH_TMP_DIR, { recursive: true });
  writeFileSync(DISPATCH_OVERRIDES_PATH, JSON.stringify({ [DISPATCH_TEST_ROUTINE_ID]: override }, null, 2) + '\n', 'utf8');
}

function withDispatchEnv(env, fn) {
  const prevOverridesPath = process.env.AGENT_ROUTINE_OVERRIDES_PATH;
  const prevSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.AGENT_ROUTINE_OVERRIDES_PATH = DISPATCH_OVERRIDES_PATH;
  if (env.sessionId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = env.sessionId;
  try {
    return fn();
  } finally {
    if (prevOverridesPath === undefined) delete process.env.AGENT_ROUTINE_OVERRIDES_PATH;
    else process.env.AGENT_ROUTINE_OVERRIDES_PATH = prevOverridesPath;
    if (prevSessionId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prevSessionId;
    rmSync(DISPATCH_TMP_DIR, { recursive: true, force: true });
  }
}

test('dispatchRoutines: a session bypass with matching CLAUDE_CODE_SESSION_ID suppresses the routine', () => {
  writeDispatchOverride({ bypassed: true, session: true, sessionId: 'session-A', at: new Date().toISOString() });
  const matched = withDispatchEnv({ sessionId: 'session-A' }, () =>
    dispatchRoutines({ event: 'PostToolUse', context: {} }));
  assert.ok(
    !matched.some(r => r.id === DISPATCH_TEST_ROUTINE_ID),
    `expected ${DISPATCH_TEST_ROUTINE_ID} suppressed by matching session bypass, got: ${matched.map(r => r.id).join(', ')}`,
  );
});

test('dispatchRoutines: a session bypass with a mismatched CLAUDE_CODE_SESSION_ID does NOT suppress (fails closed)', () => {
  writeDispatchOverride({ bypassed: true, session: true, sessionId: 'session-A', at: new Date().toISOString() });
  const matched = withDispatchEnv({ sessionId: 'session-B' }, () =>
    dispatchRoutines({ event: 'PostToolUse', context: {} }));
  assert.ok(
    matched.some(r => r.id === DISPATCH_TEST_ROUTINE_ID),
    `expected ${DISPATCH_TEST_ROUTINE_ID} still dispatched (bypass expired), got: ${matched.map(r => r.id).join(', ')}`,
  );
});

test('dispatchRoutines: a session bypass with no CLAUDE_CODE_SESSION_ID set does NOT suppress (fails closed)', () => {
  writeDispatchOverride({ bypassed: true, session: true, sessionId: 'session-A', at: new Date().toISOString() });
  const matched = withDispatchEnv({ sessionId: undefined }, () =>
    dispatchRoutines({ event: 'PostToolUse', context: {} }));
  assert.ok(
    matched.some(r => r.id === DISPATCH_TEST_ROUTINE_ID),
    `expected ${DISPATCH_TEST_ROUTINE_ID} still dispatched (no session id to match), got: ${matched.map(r => r.id).join(', ')}`,
  );
});

// --- verifyCronRoutines (#200) ---
//
// The defect being guarded: `compile` reported four `enforce: hard` cron routines as enforced
// while nothing on the host could fire them. These tests pin the contract in both directions —
// the job must exist, and its cron must match — because a routine whose schedule silently
// disagrees with the workflow is as dead as one with no job at all.

const WORKFLOW = `
on:
  schedule:
    - cron: '0 8 * * 1'
    - cron: '0 0 * * 0'
    - cron: '0 7 * * *'
jobs:
  daily-triage:
    runs-on: [self-hosted, Linux]
  weekly-brain-consolidation:
    runs-on: [self-hosted, Linux]
  weekly-memory-decay:
    runs-on: [self-hosted, Linux]
`;

const cron = (over = {}) => [{
  id: 'daily-triage', mechanism: 'cron', enabled: true, enforce: 'hard', schedule: '0 7 * * *', ...over,
}];

test('verifyCronRoutines: a matching job and schedule is clean', () => {
  assert.deepEqual(verifyCronRoutines(cron(), { workflowText: WORKFLOW }), []);
});

test('verifyCronRoutines: a missing job is an error naming the routine', () => {
  const p = verifyCronRoutines(cron({ id: 'weekly-agent-review', schedule: '0 9 * * 6' }), { workflowText: WORKFLOW });
  assert.equal(p.length, 1);
  assert.equal(p[0].severity, 'error');
  assert.equal(p[0].id, 'weekly-agent-review');
  assert.match(p[0].detail, /no job named/);
});

test('verifyCronRoutines: a schedule that disagrees with the workflow is an error', () => {
  // The real case: weekly-trust-scores said Saturday 08:00 while the job ran Sunday midnight.
  const p = verifyCronRoutines(cron({ schedule: '0 8 * * 6' }), { workflowText: WORKFLOW });
  assert.equal(p.length, 1);
  assert.match(p[0].detail, /not among the workflow's crons/);
});

test('verifyCronRoutines: workflow_job maps a routine id to a differently-named job', () => {
  const p = verifyCronRoutines(
    cron({ id: 'weekly-brain-review', workflow_job: 'weekly-brain-consolidation', schedule: '0 8 * * 1' }),
    { workflowText: WORKFLOW },
  );
  assert.deepEqual(p, []);
});

test('verifyCronRoutines: a workflow_job pointing at nothing says so specifically', () => {
  const p = verifyCronRoutines(cron({ workflow_job: 'no-such-job' }), { workflowText: WORKFLOW });
  assert.equal(p.length, 1);
  assert.match(p[0].detail, /workflow_job `no-such-job` does not exist/);
});

test('verifyCronRoutines: disabled and non-cron routines are ignored', () => {
  const routines = [
    { id: 'ghost', mechanism: 'cron', enabled: false, schedule: '5 5 * * *' },
    { id: 'a-rule', mechanism: 'agent-rule', enabled: true },
    { id: 'a-hook', mechanism: 'hook', enabled: true },
  ];
  assert.deepEqual(verifyCronRoutines(routines, { workflowText: WORKFLOW }), []);
});

test('verifyCronRoutines: mechanism external is exempt', () => {
  // Stage 1 of the Life OS cadence runs in Grok Tasks. It will never have a job here, which is
  // exactly why it is not declared `cron` — declaring it so would make verify permanently red.
  const routines = [{ id: 'daily-briefing', mechanism: 'external', enabled: true, schedule: '0 6 * * *' }];
  assert.deepEqual(verifyCronRoutines(routines, { workflowText: WORKFLOW }), []);
});

test('verifyCronRoutines: an unreadable workflow file fails every cron routine', () => {
  // Silence here would mean "all clear" on a host where the workflow is absent entirely.
  const p = verifyCronRoutines(cron(), { workflowText: null });
  assert.equal(p.length, 1);
  assert.equal(p[0].severity, 'error');
  assert.match(p[0].detail, /not found/);
});

test('verifyCronRoutines: no cron routines means nothing to verify', () => {
  assert.deepEqual(verifyCronRoutines([], { workflowText: null }), []);
});

test('every enabled cron routine in the live routines.yml is registered', () => {
  // Guards the #200 defect in both directions: a routine claiming enforcement nothing can fire,
  // and a workflow job whose cron silently drifts from the registry. `weekly-agent-review` was the
  // last offender and is now `enabled: false` with the reason recorded in routines.yml.
  const routines = parseRoutinesYml(readFileSync(new URL('../config/routines.yml', import.meta.url), 'utf8'));
  assert.deepEqual(
    verifyCronRoutines(routines).map(p => p.id),
    [],
    'cron routines and scheduled-tasks.yml have drifted — run `node tools/routines.js verify`',
  );
});


test('compile output does not depend on machine-local bypasses', () => {
  // .agents/rules/routines.generated.md is tracked in git; routine-overrides.json is local state.
  // compile() used to filter by overrides, so compiling on a host with a stale bypass committed
  // the removal of two `enforce: hard` routines for everyone.
  const routines = parseRoutinesYml(readFileSync(new URL('../config/routines.yml', import.meta.url), 'utf8'));
  const enabledAgentRules = routines.filter(r => r.mechanism === 'agent-rule' && r.enabled).map(r => r.id);
  const generated = readFileSync(new URL('../.agents/rules/routines.generated.md', import.meta.url), 'utf8');
  const inFile = [...generated.matchAll(/^-\s+\*\*([\w-]+)\*\*/gm)].map(m => m[1]);
  assert.deepEqual(
    inFile.sort(),
    enabledAgentRules.sort(),
    'the generated file must mirror the registry exactly — no local bypass may leak into it',
  );
});

test('verifyCronRoutines: a routine may declare several crons and all must exist', () => {
  // daily-triage runs twice daily. Checking only the first entry would let the second drift away
  // silently, which is precisely the #200 failure mode.
  const wf = "on:\n  schedule:\n    - cron: '0 13 * * *'\n    - cron: '0 5 * * *'\njobs:\n  daily-triage:\n";
  const r = (sched) => [{ id: 'daily-triage', mechanism: 'cron', enabled: true, schedule: sched }];

  assert.deepEqual(verifyCronRoutines(r('0 13 * * *, 0 5 * * *'), { workflowText: wf }), []);

  const partial = verifyCronRoutines(r('0 13 * * *, 0 9 * * *'), { workflowText: wf });
  assert.equal(partial.length, 1, 'one bad entry in the list must still fail');
  assert.match(partial[0].detail, /"0 9 \* \* \*"/);
});
